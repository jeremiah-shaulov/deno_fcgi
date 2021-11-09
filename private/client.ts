import {debug_assert} from './debug_assert.ts';
import {faddr_to_addr, addr_to_string} from './addr.ts';
import type {FcgiAddr} from './addr.ts';
import {FcgiConn} from "./fcgi_conn.ts";
import {SetCookies} from "./set_cookies.ts";

const BUFFER_LEN = 8*1024;
export const SERVER_SOFTWARE = 'DenoFcgi/1.0';
const DEFAULT_MAX_CONNS = 128;
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_MAX = Number.MAX_SAFE_INTEGER;
const KEEPALIVE_CHECK_EACH = 1000;
const FORGET_CONNECTION_STATE_AFTER = 10*60*60*1000;

const CONN_TYPE_INTERNAL_NO_REUSE = 0;
const CONN_TYPE_INTERNAL_REUSE = 1;
const CONN_TYPE_EXTERNAL = 2;

export interface ClientOptions
{	maxConns?: number,
	timeout?: number,
	keepAliveTimeout?: number,
	keepAliveMax?: number,
	/** Handler for errors logged from the requested service (messages printed to stderr). */
	onLogError?: (error: string) => void,
}

export interface RequestOptions
{	/** FastCGI service address. For example address of PHP-FPM service (what appears in "listen" directive in PHP-FPM pool configuration file). */
	addr: FcgiAddr | Deno.Conn,
	/** `scriptFilename` can be specified here, or in `params` under 'SCRIPT_FILENAME' key. Note that if sending to PHP-FPM, the response will be empty unless you provide this parameter. This parameter must contain PHP script file name. */
	scriptFilename?: string,
	/** Additional parameters to send to FastCGI server. If sending to PHP, they will be found in $_SERVER. If `params` object is given, it will be modified - `scriptFilename` and parameters inferred from request URL will be added to it. */
	params?: Map<string, string>,
	/** Milliseconds. Connection will be forced to close after this timeout elapses. */
	timeout?: number,
	/** Milliseconds. Idle connection will be closed if not used for this period of time. */
	keepAliveTimeout?: number,
	/** How many times to reuse this connection. */
	keepAliveMax?: number,
	/** Handler for errors logged from the requested service (messages printed to stderr). */
	onLogError?: (error: string) => void,
}

export class ResponseWithCookies extends Response
{	constructor(public body: ReadableReadableStream | null, init?: ResponseInit|undefined, public cookies = new SetCookies)
	{	super(body, init);
	}
}

export class ReadableReadableStream extends ReadableStream<Uint8Array> implements Deno.Reader
{	private is_reading = false;

	constructor(private body_first_part: Uint8Array|undefined, private body_it: AsyncGenerator<number, number, Uint8Array>, private ondone: () => void)
	{	super
		(	{	pull: async (controller) =>
				{	try
					{	if (!this.is_reading)
						{	// initially enqueue 1 empty chunk, befire user decides does he want to read this object through `ReadableStream`, or through `Deno.Reader`
							this.is_reading = true;
							controller.enqueue(new Uint8Array);
						}
						else if (this.body_first_part)
						{	controller.enqueue(this.body_first_part); // "enqueue()" consumes the buffer by setting "value.buffer.byteLength" to "0"
							this.body_first_part = undefined;
						}
						else
						{	let buffer = new Uint8Array(BUFFER_LEN);
							let {value: n_read, done} = await this.body_it.next(buffer);
							if (!done)
							{	controller.enqueue(buffer.subarray(0, n_read as number)); // "enqueue()" consumes the buffer by setting "value.buffer.byteLength" to "0"
							}
							else
							{	this.ondone();
								controller.close();
							}
						}
					}
					catch (e)
					{	controller.error(e);
						controller.close();
					}
				}
			}
		);
	}

	async read(buffer: Uint8Array): Promise<number | null>
	{	if (this.body_first_part)
		{	let len = this.body_first_part.length;
			if (buffer.length >= len)
			{	buffer.set(this.body_first_part);
				this.body_first_part = undefined;
				return len;
			}
			else
			{	buffer.set(this.body_first_part.subarray(0, buffer.length));
				this.body_first_part = this.body_first_part.subarray(buffer.length);
				return buffer.length;
			}
		}
		let {value: n_read, done} = await this.body_it.next(buffer);
		if (!done)
		{	return n_read as number;
		}
		this.ondone();
		return null;
	}
}

class FcgiConns
{	public idle: FcgiConn[] = [];
	public busy: FcgiConn[] = [];
	public no_reuse_connection_since = 0; // 0 means reusing connection is supported. Set to Date.now() after first unsuccessful attempt.
}

export class Client
{	private conns_pool = new Map<string, FcgiConns>();
	private n_idle_all = 0;
	private n_busy_all = 0;
	private h_timer: number | undefined;
	private can_fetch_callbacks: (() => void)[] = [];
	private onerror: (error: Error) => void = () => {};

	private maxConns: number;
	private timeout: number;
	private keepAliveTimeout: number;
	private keepAliveMax: number;
	private onLogError: ((error: string) => void) | undefined;

	constructor(options?: ClientOptions)
	{	this.maxConns = options?.maxConns || DEFAULT_MAX_CONNS;
		this.timeout = options?.timeout || DEFAULT_TIMEOUT;
		this.keepAliveTimeout = options?.keepAliveTimeout || DEFAULT_KEEP_ALIVE_TIMEOUT;
		this.keepAliveMax = options?.keepAliveMax || DEFAULT_KEEP_ALIVE_MAX;
		this.onLogError = options?.onLogError;
	}

	/**	Set and/or get configuration.
	 **/
	options(options?: ClientOptions): ClientOptions
	{	this.maxConns = options?.maxConns ?? this.maxConns;
		this.timeout = options?.timeout ?? this.timeout;
		this.keepAliveTimeout = options?.keepAliveTimeout ?? this.keepAliveTimeout;
		this.keepAliveMax = options?.keepAliveMax ?? this.keepAliveMax;
		this.onLogError = options?.onLogError ?? this.onLogError;
		let {maxConns, timeout, keepAliveTimeout, keepAliveMax, onLogError} = this;
		return {maxConns, timeout, keepAliveTimeout, keepAliveMax, onLogError};
	}

	/**	`onError(callback)` - catch general connection errors. Only one handler is active. Second `onError(callback2)` overrides the previous handler.
		`onError(undefined)` - removes the event handler.
	 **/
	onError(callback?: (error: Error) => unknown)
	{	this.onerror = !callback ? () => {} : error =>
		{	try
			{	callback(error);
			}
			catch (e)
			{	console.error(e);
			}
		};
	}

	/**	If `keepAliveTimeout` option was > 0, `fcgi.fetch()` will reuse connections. After each fetch, connection will wait for specified number of milliseconds for next fetch. Idle connections don't let Deno application from exiting naturally.
		You can call `fcgi.closeIdle()` to close all idle connections.
	 **/
	closeIdle()
	{	this.close_kept_alive_timed_out(true);
		debug_assert(this.n_idle_all == 0);
	}

	async fetch(request_options: RequestOptions, input: Request|URL|string, init?: RequestInit & {bodyIter?: AsyncIterable<Uint8Array>}): Promise<ResponseWithCookies>
	{	let {addr, scriptFilename, params, timeout, keepAliveTimeout, keepAliveMax, onLogError} = request_options;
		if (timeout == undefined)
		{	timeout = this.timeout;
		}
		if (keepAliveTimeout == undefined)
		{	keepAliveTimeout = this.keepAliveTimeout;
		}
		if (keepAliveMax == undefined)
		{	keepAliveMax = this.keepAliveMax;
		}
		if (onLogError == undefined)
		{	onLogError = this.onLogError;
		}
		// input
		if (!(input instanceof Request))
		{	input = new Request(input+'', init);
		}
		// params
		if (params == undefined)
		{	params = new Map;
		}
		if (scriptFilename != undefined)
		{	params.set('SCRIPT_FILENAME', scriptFilename);
		}
		let url_obj = new URL(input.url, 'http://localhost/');
		params.set('REQUEST_METHOD', input.method);
		params.set('REQUEST_SCHEME', url_obj.protocol.slice(0, -1));
		params.set('HTTP_HOST', url_obj.hostname);
		params.set('REQUEST_URI', url_obj.pathname + url_obj.search);
		params.set('QUERY_STRING', url_obj.search.slice(1));
		params.set('SERVER_SOFTWARE', SERVER_SOFTWARE);
		for (let [name, value] of input.headers)
		{	if (name == 'content-type')
			{	params.set('CONTENT_TYPE', value);
			}
			else
			{	params.set('HTTP_'+name.replaceAll('-', '_').toUpperCase(), value);
			}
		}
		// get_conn
		var {conn, server_addr_str, conn_type} = await this.get_conn(addr, timeout, keepAliveTimeout, keepAliveMax);
		conn.on_log_error = onLogError;
		// query
		let buffer = new Uint8Array(BUFFER_LEN);
		try
		{	while (true)
			{	try
				{	await conn.write_request(params, init?.bodyIter ?? input.body, conn_type!=CONN_TYPE_INTERNAL_NO_REUSE);
				}
				catch (e)
				{	if (conn_type==CONN_TYPE_INTERNAL_REUSE && e.name=='BrokenPipe')
					{	// unset "no_reuse_connection_since" for this "server_addr_str"
						conn_type = CONN_TYPE_INTERNAL_NO_REUSE;
						this.return_conn(server_addr_str, conn, conn_type);
						let conns = this.get_conns(server_addr_str);
						conns.no_reuse_connection_since = Date.now();
						var {conn} = await this.get_conn(server_addr_str, timeout, keepAliveTimeout, keepAliveMax);
						continue;
					}
					throw e;
				}
				break;
			}
			var it = conn.read_response(buffer);
			let {value: n_read, done} = await it.next(buffer); // this reads all the headers before getting to the body
			buffer = buffer.subarray(0, done ? 0 : n_read as number);
		}
		catch (e)
		{	this.return_conn(server_addr_str, conn, CONN_TYPE_INTERNAL_NO_REUSE);
			throw e;
		}
		// return
		let status = conn.headers.get('status');
		if (status != null)
		{	conn.headers.delete('status');
		}
		let status_str = status || '';
		let pos = status_str.indexOf(' ');
		let headers = conn.headers;
		let cookies = conn.cookies;
		conn.headers = new Headers;
		conn.cookies = new SetCookies;
		if (buffer.length == 0)
		{	this.return_conn(server_addr_str, conn, conn_type);
		}
		return new ResponseWithCookies
		(	buffer.length==0 ? null : new ReadableReadableStream
			(	buffer,
				it,
				() =>
				{	this.return_conn(server_addr_str, conn, conn_type);
				}
			),
			{	status: parseInt(status_str) || 200,
				statusText: pos==-1 ? '' : status_str.slice(pos+1).trim(),
				headers,
			},
			cookies
		);
	}

	async fetchCapabilities(addr: FcgiAddr | Deno.Conn)
	{	let {conn, server_addr_str} = await this.get_conn(addr, DEFAULT_TIMEOUT, 0, 1);
		await conn.write_record_get_values(new Map(Object.entries({FCGI_MAX_CONNS: '', FCGI_MAX_REQS: '', FCGI_MPXS_CONNS: ''})));
		let header = await conn.read_record_header();
		let map = await conn.read_record_get_values_result(header.content_length, header.padding_length);
		this.return_conn(server_addr_str, conn, CONN_TYPE_INTERNAL_NO_REUSE);
		let fcgi_max_conns = map.get('FCGI_MAX_CONNS');
		let fcgi_max_reqs = map.get('FCGI_MAX_REQS');
		let fcgi_mpxs_conns = map.get('FCGI_MPXS_CONNS');
		let result: {FCGI_MAX_CONNS?: number, FCGI_MAX_REQS?: number, FCGI_MPXS_CONNS?: number} = {};
		if (fcgi_max_conns != undefined)
		{	result.FCGI_MAX_CONNS = Number(fcgi_max_conns);
		}
		if (fcgi_max_reqs != undefined)
		{	result.FCGI_MAX_REQS = Number(fcgi_max_reqs);
		}
		if (fcgi_mpxs_conns != undefined)
		{	result.FCGI_MPXS_CONNS = Number(fcgi_mpxs_conns);
		}
		return result;
	}

	/**	When number of ongoing requests is more than the configured value (`maxConns`), `fetch()` and `fetchCapabilities()` will wait.
		`canFetch()` checks whether there are free slots, and returns true if so.
		It's recommended not to call `fetch()` untill `canFetch()` grants a green light.
		Example:
		```
		if (!fcgi.canFetch())
		{	await fcgi.waitCanFetch();
		}
		await fcgi.fetch(...);
		```
	 **/
	canFetch(): boolean
	{	return this.n_busy_all < this.maxConns;
	}

	async waitCanFetch(): Promise<void>
	{	while (this.n_busy_all >= this.maxConns)
		{	await new Promise<void>(y => {this.can_fetch_callbacks.push(y)});
		}
	}

	private get_conns(server_addr_str: string)
	{	let conns = this.conns_pool.get(server_addr_str);
		if (!conns)
		{	conns = new FcgiConns;
			this.conns_pool.set(server_addr_str, conns);
		}
		return conns;
	}

	private async get_conn(addr: FcgiAddr | Deno.Conn, timeout: number, keepAliveTimeout: number, keepAliveMax: number): Promise<{conn: FcgiConn, server_addr_str: string, conn_type: number}>
	{	debug_assert(this.n_idle_all>=0 && this.n_busy_all>=0);
		while (this.n_busy_all >= this.maxConns)
		{	await new Promise<void>(y => {this.can_fetch_callbacks.push(y)});
		}
		let server_addr;
		let external_conn;
		if (typeof(addr)=='object' && 'remoteAddr' in addr)
		{	server_addr = addr.remoteAddr;
			external_conn = addr;
		}
		else
		{	server_addr = faddr_to_addr(addr);
		}
		let server_addr_str = addr_to_string(server_addr);
		let conns = this.get_conns(server_addr_str);
		let {idle, busy, no_reuse_connection_since} = conns;
		let conn_type = no_reuse_connection_since==0 ? CONN_TYPE_INTERNAL_REUSE : CONN_TYPE_INTERNAL_NO_REUSE;
		let now = Date.now();
		while (true)
		{	let conn;
			if (external_conn)
			{	conn = new FcgiConn(external_conn);
				conn_type = CONN_TYPE_EXTERNAL;
			}
			else
			{	conn = idle.pop();
				if (!conn)
				{	conn = new FcgiConn(await Deno.connect(server_addr as any));
				}
				else if (conn.use_till <= now)
				{	this.n_idle_all--;
					try
					{	conn.close();
					}
					catch (e)
					{	this.onerror(e);
					}
					continue;
				}
				else
				{	this.n_idle_all--;
				}
			}
			debug_assert(conn.request_till == 0);
			conn.request_till = now + timeout;
			conn.use_till = Math.min(conn.use_till, now+keepAliveTimeout);
			conn.use_n_times = Math.min(conn.use_n_times, keepAliveMax);
			if (this.h_timer == undefined)
			{	this.h_timer = setInterval(() => {this.close_kept_alive_timed_out()}, KEEPALIVE_CHECK_EACH);
			}
			busy.push(conn);
			this.n_busy_all++;
			this.close_exceeding_idle_conns(idle);
			return {conn, server_addr_str, conn_type};
		}
	}

	/**	Call with CONN_TYPE_INTERNAL_NO_REUSE to close the connection, even if it's external.
	 **/
	private return_conn(server_addr_str: string, conn: FcgiConn, conn_type: number)
	{	let conns = this.conns_pool.get(server_addr_str);
		if (!conns)
		{	// assume: return_conn() already called for this connection
			return;
		}
		let i = conns.busy.indexOf(conn);
		if (i == -1)
		{	// assume: return_conn() already called for this connection
			return;
		}
		debug_assert(conn.request_till > 0);
		this.n_busy_all--;
		debug_assert(this.n_idle_all>=0 && this.n_busy_all>=0);
		conns.busy[i] = conns.busy[conns.busy.length - 1];
		conns.busy.length--;
		if (conn_type==CONN_TYPE_INTERNAL_NO_REUSE || --conn.use_n_times<=0 || conn.use_till<=Date.now())
		{	try
			{	conn.close();
			}
			catch (e)
			{	this.onerror(e);
			}
		}
		else
		{	conn.request_till = 0;
			if (conn_type != CONN_TYPE_EXTERNAL)
			{	conns.idle.push(conn);
				this.n_idle_all++;
			}
		}
		if (this.n_busy_all < this.maxConns)
		{	let n = this.can_fetch_callbacks.length;
			if (n > 0)
			{	while (n-- > 0)
				{	this.can_fetch_callbacks[n]();
				}
				this.can_fetch_callbacks.length = 0;
			}
			else if (this.n_busy_all == 0)
			{	this.close_kept_alive_timed_out();
			}
		}
	}

	private close_kept_alive_timed_out(close_all_idle=false)
	{	let {conns_pool} = this;
		let now = Date.now();
		for (let [server_addr_str, conns] of conns_pool)
		{	let {idle, busy, no_reuse_connection_since} = conns;
			// Some request timed out?
			for (let i=busy.length-1; i>=0; i--)
			{	let conn = busy[i];
				debug_assert(conn.request_till > 0);
				if (conn.request_till <= now)
				{	this.return_conn(server_addr_str, conn, CONN_TYPE_INTERNAL_NO_REUSE);
				}
			}
			// Some idle connection is no longer needed?
			for (let i=idle.length-1; i>=0; i--)
			{	let conn = idle[i];
				debug_assert(conn.request_till == 0);
				if (conn.use_till<=now || close_all_idle)
				{	idle.splice(i, 1);
					this.n_idle_all--;
					try
					{	conn.close();
					}
					catch (e)
					{	this.onerror(e);
					}
				}
			}
			//
			if (no_reuse_connection_since && no_reuse_connection_since+FORGET_CONNECTION_STATE_AFTER < now)
			{	no_reuse_connection_since = 0;
				conns.no_reuse_connection_since = 0;
			}
			if (busy.length+idle.length==0 && !no_reuse_connection_since)
			{	conns_pool.delete(server_addr_str);
			}
		}
		if (this.n_busy_all+this.n_idle_all == 0)
		{	clearInterval(this.h_timer);
			this.h_timer = undefined;
		}
	}

	private close_exceeding_idle_conns(idle: FcgiConn[])
	{	debug_assert(this.n_busy_all <= this.maxConns);
		let n_close_idle = this.n_busy_all + this.n_idle_all - this.maxConns;
		while (n_close_idle > 0)
		{	let conn = idle.pop();
			if (!conn)
			{	for (let c_conns of this.conns_pool.values())
				{	while (true)
					{	conn = c_conns.idle.pop();
						if (!conn)
						{	break;
						}
						n_close_idle--;
						this.n_idle_all--;
						try
						{	conn.close();
						}
						catch (e)
						{	this.onerror(e);
						}
						debug_assert(this.n_idle_all >= 0);
						if (n_close_idle == 0)
						{	return;
						}
					}
				}
				return;
			}
			n_close_idle--;
			this.n_idle_all--;
			try
			{	conn.close();
			}
			catch (e)
			{	this.onerror(e);
			}
			debug_assert(this.n_idle_all >= 0);
		}
	}
}
