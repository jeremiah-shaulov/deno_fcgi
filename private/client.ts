import {debug_assert} from './debug_assert.ts';
import {Conn} from './deno_ifaces.ts';
import {faddr_to_addr, addr_to_string} from './addr.ts';
import type {FcgiAddr} from './addr.ts';
import {FcgiConn} from "./fcgi_conn.ts";
import {SetCookies} from "./set_cookies.ts";
import {RdStream} from './deps.ts';

export const SERVER_SOFTWARE = 'DenoFcgi/1.0';
const BUFFER_LEN = 8*1024;
const DEFAULT_MAX_CONNS = 128;
const DEFAULT_CONNECT_TIMEOUT = 4000;
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_MAX = Number.MAX_SAFE_INTEGER;
const KEEPALIVE_CHECK_EACH = 1000;

const enum ConnType
{	NEW = 0,
	FROM_POOL = 1,
	EXTERNAL = 2,
	WANT_CLOSE = 4, // can be ored to other value (e.g. `ConnType.NEW | ConnType.WANT_CLOSE`)
}

const EOF_MARK = new Uint8Array;

const RE_CHARSET = /;\s*charset\s*=\s*\"?([^";]+)/;

// deno-lint-ignore no-explicit-any
type Any = any;

export interface ClientOptions
{	maxConns?: number,
	connectTimeout?: number,
	timeout?: number,
	keepAliveTimeout?: number,
	keepAliveMax?: number,
	/** Handler for errors logged from the requested service (messages printed to stderr). */
	onLogError?: (error: string) => void,
}

export interface RequestOptions
{	/** FastCGI service address. For example address of PHP-FPM service (what appears in "listen" directive in PHP-FPM pool configuration file). */
	addr: FcgiAddr | Conn,
	/** `scriptFilename` can be specified here, or in `params` under 'SCRIPT_FILENAME' key. Note that if sending to PHP-FPM, the response will be empty unless you provide this parameter. This parameter must contain PHP script file name. */
	scriptFilename?: string,
	/** Additional parameters to send to FastCGI server. If sending to PHP, they will be found in $_SERVER. If `params` object is given, it will be modified - `scriptFilename` and parameters inferred from request URL will be added to it. */
	params?: Map<string, string>,
	/** Milliseconds. If socket connection takes longer, it will be forced to close. */
	connectTimeout?: number,
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
{	#charset: string|undefined;

	constructor(public override body: RdStream|null, init?: ResponseInit|undefined, public cookies = new SetCookies)
	{	super(body, init);
	}

	get charset()
	{	if (this.#charset == undefined)
		{	this.#charset = '';
			const content_type = this.headers.get('content-type');
			if (content_type)
			{	const m = content_type.match(RE_CHARSET);
				if (m)
				{	this.#charset = m[1].trim();
				}
			}
		}
		return this.#charset;
	}

	override text()
	{	return !this.body ? Promise.resolve('') : this.body.text(this.charset || undefined);
	}

	uint8Array()
	{	return !this.body ? Promise.resolve(new Uint8Array) : this.body.uint8Array();
	}
}

class FcgiConns
{	idle = new Array<FcgiConn>;
	busy = new Array<FcgiConn>;
}

export class Client
{	private conns_pool = new Map<string, FcgiConns>();
	private n_idle_all = 0;
	private n_busy_all = 0;
	private h_timer: number | undefined;
	private can_fetch_callbacks = new Array<() => void>;
	private onerror: (error: Error) => void = () => {};

	private maxConns: number;
	private connectTimeout: number;
	private timeout: number;
	private keepAliveTimeout: number;
	private keepAliveMax: number;
	private onLogError: ((error: string) => void) | undefined;

	constructor(options?: ClientOptions)
	{	this.maxConns = options?.maxConns || DEFAULT_MAX_CONNS;
		this.connectTimeout = options?.connectTimeout || DEFAULT_CONNECT_TIMEOUT;
		this.timeout = options?.timeout || DEFAULT_TIMEOUT;
		this.keepAliveTimeout = options?.keepAliveTimeout || DEFAULT_KEEP_ALIVE_TIMEOUT;
		this.keepAliveMax = options?.keepAliveMax || DEFAULT_KEEP_ALIVE_MAX;
		this.onLogError = options?.onLogError;
	}

	/**	Set and/or get configuration.
	 **/
	options(options?: ClientOptions): ClientOptions
	{	this.maxConns = options?.maxConns ?? this.maxConns;
		this.connectTimeout = options?.connectTimeout ?? this.connectTimeout;
		this.timeout = options?.timeout ?? this.timeout;
		this.keepAliveTimeout = options?.keepAliveTimeout ?? this.keepAliveTimeout;
		this.keepAliveMax = options?.keepAliveMax ?? this.keepAliveMax;
		this.onLogError = options?.onLogError ?? this.onLogError;
		const {maxConns, connectTimeout, timeout, keepAliveTimeout, keepAliveMax, onLogError} = this;
		return {maxConns, connectTimeout, timeout, keepAliveTimeout, keepAliveMax, onLogError};
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

	async fetch(request_options: RequestOptions, input: Request|URL|string, init?: RequestInit)
	{	let {addr, scriptFilename, params, connectTimeout, timeout, keepAliveTimeout, keepAliveMax, onLogError} = request_options;
		if (connectTimeout == undefined)
		{	connectTimeout = this.connectTimeout;
		}
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
		const url_obj = new URL(input.url, 'http://localhost/');
		params.set('REQUEST_METHOD', input.method);
		params.set('REQUEST_SCHEME', url_obj.protocol.slice(0, -1));
		params.set('HTTP_HOST', url_obj.hostname);
		params.set('REQUEST_URI', url_obj.pathname + url_obj.search);
		params.set('QUERY_STRING', url_obj.search.slice(1));
		params.set('SERVER_SOFTWARE', SERVER_SOFTWARE);
		for (const [name, value] of input.headers)
		{	if (name == 'content-type')
			{	params.set('CONTENT_TYPE', value);
			}
			else if (name == 'content-length')
			{	params.set('CONTENT_LENGTH', value);
			}
			else
			{	params.set('HTTP_'+name.replaceAll('-', '_').toUpperCase(), value);
			}
		}
		// get_conn
		// deno-lint-ignore no-var
		var {conn, server_addr_str, conn_type} = await this.get_conn(addr, connectTimeout, timeout, keepAliveTimeout, keepAliveMax);
		conn.on_log_error = onLogError;
		// query
		let first_buffer: Uint8Array|undefined = new Uint8Array(BUFFER_LEN);
		try
		{	while (true)
			{	try
				{	await conn.write_request(params, input.body, true);
				}
				catch (e)
				{	if (conn_type==ConnType.FROM_POOL && (e instanceof Error) && e.name=='BrokenPipe')
					{	this.return_conn(server_addr_str, conn, conn_type|ConnType.WANT_CLOSE);
						// deno-lint-ignore no-inner-declarations no-redeclare no-var
						var {conn, conn_type} = await this.get_conn(server_addr_str, connectTimeout, timeout, keepAliveTimeout, keepAliveMax);
						conn.on_log_error = onLogError;
						continue;
					}
					throw e;
				}
				break;
			}
			// deno-lint-ignore no-inner-declarations no-var
			var response_reader = conn.get_response_reader();
			const n_read = await response_reader.read(first_buffer); // this reads all the headers before getting to the body
			first_buffer = !n_read ? undefined : first_buffer.subarray(0, n_read);
		}
		catch (e)
		{	this.return_conn(server_addr_str, conn, conn_type|ConnType.WANT_CLOSE);
			throw e;
		}
		// return
		const status = conn.headers.get('status');
		if (status != null)
		{	conn.headers.delete('status');
		}
		const status_str = status || '';
		const pos = status_str.indexOf(' ');
		const headers = conn.headers;
		const cookies = conn.cookies;
		conn.headers = new Headers;
		conn.cookies = new SetCookies;
		if (!first_buffer)
		{	this.return_conn(server_addr_str, conn, conn_type);
		}
		// deno-lint-ignore no-this-alias
		const that = this;
		return new ResponseWithCookies
		(	!first_buffer ? null : new RdStream
			(	{	async read(buffer: Uint8Array)
					{	if (first_buffer)
						{	if (first_buffer == EOF_MARK)
							{	return 0;
							}
							const n = Math.min(buffer.length, first_buffer.length);
							buffer.set(first_buffer.subarray(0, n));
							first_buffer = n>=first_buffer.length ? undefined : first_buffer.subarray(n);
							return n;
						}
						try
						{	const n = await response_reader.read(buffer);
							if (n == null)
							{	first_buffer = EOF_MARK;
								that.return_conn(server_addr_str, conn, conn_type);
							}
							return n;
						}
						catch (e)
						{	that.return_conn(server_addr_str, conn, conn_type);
							throw e;
						}
					}
				}
			),
			{	status: parseInt(status_str) || 200,
				statusText: pos==-1 ? '' : status_str.slice(pos+1).trim(),
				headers,
			},
			cookies
		);
	}

	async fetchCapabilities(addr: FcgiAddr | Conn)
	{	const {conn, server_addr_str, conn_type} = await this.get_conn(addr, DEFAULT_CONNECT_TIMEOUT, DEFAULT_TIMEOUT, 0, 1);
		await conn.write_record_get_values(new Map(Object.entries({FCGI_MAX_CONNS: '', FCGI_MAX_REQS: '', FCGI_MPXS_CONNS: ''})));
		const header = await conn.read_record_header();
		const map = await conn.read_record_get_values_result(header.content_length, header.padding_length);
		this.return_conn(server_addr_str, conn, conn_type|ConnType.WANT_CLOSE);
		const fcgi_max_conns = map.get('FCGI_MAX_CONNS');
		const fcgi_max_reqs = map.get('FCGI_MAX_REQS');
		const fcgi_mpxs_conns = map.get('FCGI_MPXS_CONNS');
		const result: {FCGI_MAX_CONNS?: number, FCGI_MAX_REQS?: number, FCGI_MPXS_CONNS?: number} = {};
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

		```ts
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

	private async get_conn(addr: FcgiAddr | Conn, connectTimeout: number, timeout: number, keepAliveTimeout: number, keepAliveMax: number)
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
		const server_addr_str = addr_to_string(server_addr);
		const conns = this.get_conns(server_addr_str);
		const {idle, busy} = conns;
		let conn_type = ConnType.FROM_POOL;
		const now = Date.now();
		while (true)
		{	let conn;
			if (external_conn)
			{	conn = new FcgiConn(external_conn);
				conn_type = ConnType.EXTERNAL;
			}
			else
			{	conn = idle.pop();
				if (!conn)
				{	conn = new FcgiConn(await connect(server_addr as Any, connectTimeout));
					conn_type = ConnType.NEW;
				}
				else if (conn.use_till <= now)
				{	this.n_idle_all--;
					try
					{	conn.close();
					}
					catch (e)
					{	this.onerror(e instanceof Error ? e : new Error(e+''));
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

	/**	Call with ConnType.INTERNAL_NO_REUSE to close the connection, even if it's external.
	 **/
	private return_conn(server_addr_str: string, conn: FcgiConn, conn_type: ConnType)
	{	const conns = this.conns_pool.get(server_addr_str);
		if (!conns)
		{	// assume: return_conn() already called for this connection
			return;
		}
		const i = conns.busy.indexOf(conn);
		if (i == -1)
		{	// assume: return_conn() already called for this connection
			return;
		}
		debug_assert(conn.request_till > 0);
		this.n_busy_all--;
		debug_assert(this.n_idle_all>=0 && this.n_busy_all>=0);
		conns.busy[i] = conns.busy[conns.busy.length - 1];
		conns.busy.length--;
		if ((conn_type&ConnType.WANT_CLOSE) || --conn.use_n_times<=0 || conn.use_till<=Date.now())
		{	try
			{	conn.close();
			}
			catch (e)
			{	this.onerror(e instanceof Error ? e : new Error(e+''));
			}
		}
		else
		{	conn.request_till = 0;
			if (conn_type != ConnType.EXTERNAL)
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
	{	const {conns_pool} = this;
		const now = Date.now();
		for (const [server_addr_str, conns] of conns_pool)
		{	const {idle, busy} = conns;
			// Some request timed out?
			for (let i=busy.length-1; i>=0; i--)
			{	const conn = busy[i];
				debug_assert(conn.request_till > 0);
				if (conn.request_till <= now)
				{	this.return_conn(server_addr_str, conn, ConnType.WANT_CLOSE);
				}
			}
			// Some idle connection is no longer needed?
			for (let i=idle.length-1; i>=0; i--)
			{	const conn = idle[i];
				debug_assert(conn.request_till == 0);
				if (conn.use_till<=now || close_all_idle)
				{	idle.splice(i, 1);
					this.n_idle_all--;
					try
					{	conn.close();
					}
					catch (e)
					{	this.onerror(e instanceof Error ? e : new Error(e+''));
					}
				}
			}
			//
			if (busy.length+idle.length == 0)
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
			{	for (const c_conns of this.conns_pool.values())
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
						{	this.onerror(e instanceof Error ? e : new Error(e+''));
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
			{	this.onerror(e instanceof Error ? e : new Error(e+''));
			}
			debug_assert(this.n_idle_all >= 0);
		}
	}
}

async function connect(options: Deno.ConnectOptions, connectTimeout: number)
{	const want_conn = Deno.connect(options);
	let timer_resolve: VoidFunction;
	const timer_promise = new Promise<void>(y => {timer_resolve = y});
	const timer = setTimeout(timer_resolve!, connectTimeout);
	const maybe_conn = await Promise.race([want_conn, timer_promise]);
	if (!maybe_conn)
	{	want_conn.then(conn => conn.close()).catch(() => {});
		throw new Error(`Connection timed out to ${JSON.stringify(options)}`);
	}
	clearTimeout(timer);
	return maybe_conn;
}
