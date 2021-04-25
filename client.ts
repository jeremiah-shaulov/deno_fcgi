import {debug_assert} from './debug_assert.ts';
import {faddr_to_addr, addr_to_string} from './addr.ts';
import type {FcgiAddr} from './addr.ts';
import {FcgiConn} from "./fcgi_conn.ts";
import {SetCookies} from "./set_cookies.ts";
import {TooManyConnsError} from './error.ts';

export const SERVER_SOFTWARE = 'DenoFcgi/0.0';
const DEFAULT_MAX_CONNS = 128;
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_MAX = Number.MAX_SAFE_INTEGER;
const KEEPALIVE_CHECK_EACH = 1000;
const FORGET_CONNECTION_STATE_AFTER = 10*60*60*1000;

export interface ClientOptions
{	maxConns?: number,
	timeout?: number,
	keepAliveTimeout?: number,
	keepAliveMax?: number,
	/** Handler for errors logged from the requested service. */
	onLogError?: (error: string) => void,
}

export interface RequestOptions
{	/** FastCGI service address. For example address of PHP-FPM service (what appears in "listen" directive in PHP-FPM pool configuration file). */
	addr: FcgiAddr,
	/** `scriptFilename` can be specified here, or in `params` under 'SCRIPT_FILENAME' key. Note that if sending to PHP-FPM, the response will be empty unless you provide this parameter. This parameter must contain PHP script file name. */
	scriptFilename?: string,
	/** Additional parameters to send to FastCGI server. If sending to PHP, they will be found in $_SERVER. If `params` object is given, it will be modified - `scriptFilename` and parameters inferred from request URL will be added to it. */
	params?: Map<string, string>,
	timeout?: number,
	keepAliveTimeout?: number,
	keepAliveMax?: number,
	/** Handler for errors logged from the requested service. */
	onLogError?: (error: string) => void,
}

export class ResponseWithCookies extends Response
{	constructor(body?: BodyInit|null|undefined, init?: ResponseInit|undefined, public cookies = new SetCookies)
	{	super(body, init);
	}
}

class FcgiConns
{	public idle: FcgiConn[] = [];
	public busy: FcgiConn[] = [];
	public supports_reuse_connection = true; // set to false after first unsuccessful attempt
	public last_use_time = Date.now();
}

export class Client
{	private conns_pool = new Map<string, FcgiConns>();
	private n_idle_all = 0;
	private n_busy_all = 0;
	private h_timer: number | undefined;
	private can_fetch_callbacks: (() => void)[] = [];

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

	options(options: ClientOptions): ClientOptions
	{	this.maxConns = options.maxConns ?? this.maxConns;
		this.timeout = options.timeout ?? this.timeout;
		this.keepAliveTimeout = options.keepAliveTimeout ?? this.keepAliveTimeout;
		this.keepAliveMax = options.keepAliveMax ?? this.keepAliveMax;
		this.onLogError = options.onLogError ?? this.onLogError;
		let {maxConns, timeout, keepAliveTimeout, keepAliveMax, onLogError} = this;
		return {maxConns, timeout, keepAliveTimeout, keepAliveMax, onLogError};
	}

	async fetch(server_options: RequestOptions, input: Request|URL|string, init?: RequestInit): Promise<ResponseWithCookies>
	{	let {addr, scriptFilename, params, timeout, keepAliveTimeout, keepAliveMax, onLogError} = server_options;
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
		// server_addr
		let server_addr = faddr_to_addr(addr);
		let server_addr_str = addr_to_string(server_addr);
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
		let url_obj = new URL(input.url, 'https://deno.land/x/fcgi/');
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
		//
		let headers = new Headers;
		let cookies = new SetCookies;
		// get_conn
		var {conn, supports_reuse_connection} = await this.get_conn(server_addr_str, server_addr, timeout, keepAliveTimeout, keepAliveMax);
		// query
		try
		{	while (true)
			{	try
				{	await conn.write_request(params, input.body, supports_reuse_connection);
				}
				catch (e)
				{	if (supports_reuse_connection && e.name=='BrokenPipe')
					{	// unset "supports_reuse_connection" for this "server_addr_str"
						supports_reuse_connection = false;
						this.return_conn(server_addr_str, conn, false);
						this.get_conns(server_addr_str).supports_reuse_connection = false;
						var {conn} = await this.get_conn(server_addr_str, server_addr, timeout, keepAliveTimeout, keepAliveMax);
						continue;
					}
					throw e;
				}
				break;
			}
			var it = conn.read_response(headers, cookies, onLogError);
			var {value, done} = await it.next();
		}
		catch (e)
		{	this.return_conn(server_addr_str, conn, false);
			throw e;
		}
		// return
		let status_str = headers.get('status') || '';
		let pos = status_str.indexOf(' ');
		if (done)
		{	this.return_conn(server_addr_str, conn, supports_reuse_connection);
		}
		let that = this;
		return new ResponseWithCookies
		(	done ? value : new ReadableStream
			(	{	type: 'bytes',
					start(controller)
					{	controller.enqueue(value.slice()); // "enqueue()" consumes the buffer by setting "value.buffer.byteLength" to "0", so slice() is needed
					},
					async pull(controller)
					{	let {value, done} = await it.next();
						if (done)
						{	that.return_conn(server_addr_str, conn, supports_reuse_connection);
							controller.close();
						}
						else
						{	controller.enqueue(value.slice()); // "enqueue()" consumes the buffer by setting "value.buffer.byteLength" to "0", so slice() is needed
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

	async fetchCapabilities(addr: FcgiAddr)
	{	let server_addr = faddr_to_addr(addr);
		let server_addr_str = addr_to_string(server_addr);
		let {conn} = await this.get_conn(server_addr_str, server_addr, DEFAULT_TIMEOUT, 0, 1);
		await conn.write_record_get_values(new Map(Object.entries({FCGI_MAX_CONNS: '', FCGI_MAX_REQS: '', FCGI_MPXS_CONNS: ''})));
		let header = await conn.read_record_header();
		let map = await conn.read_record_get_values_result(header.content_length, header.padding_length);
		this.return_conn(server_addr_str, conn, false);
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

	/**	`fetch()` and `fetchCapabilities()` throw Error if number of ongoing requests is more than the configured value (`maxConns`).
		`canFetch()` checks whether there are free slots, and returns true if so.
		It's recommended not to call `fetch()` untill `canFetch()` grants a green light.
		Example:
		```
		while (!fcgi.canFetch())
		{	await fcgi.pollCanFetch();
		}
		await fcgi.fetch(...);
		```
	 **/
	canFetch(): boolean
	{	return this.n_busy_all < this.maxConns;
	}

	pollCanFetch(): Promise<void>
	{	if (this.n_busy_all < this.maxConns)
		{	return Promise.resolve();
		}
		let promise = new Promise<void>(y => {this.can_fetch_callbacks.push(y)});
		return promise;
	}

	private get_conns(server_addr_str: string)
	{	let conns = this.conns_pool.get(server_addr_str);
		if (!conns)
		{	conns = new FcgiConns;
			this.conns_pool.set(server_addr_str, conns);
		}
		return conns;
	}

	private async get_conn(server_addr_str: string, server_addr: Deno.Addr, timeout: number, keepAliveTimeout: number, keepAliveMax: number)
	{	debug_assert(this.n_idle_all>=0 && this.n_busy_all>=0);
		if (this.n_busy_all >= this.maxConns)
		{	throw new TooManyConnsError('Too many connections');
		}
		let conns = this.get_conns(server_addr_str);
		let {idle, busy, supports_reuse_connection} = conns;
		let now = Date.now();
		while (true)
		{	let conn = idle.pop();
			if (!conn)
			{	conn = new FcgiConn(await Deno.connect(server_addr as any));
			}
			else if (conn.use_till <= now)
			{	this.n_idle_all--;
				conn.close();
				continue;
			}
			else
			{	this.n_idle_all--;
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
			return {conn, supports_reuse_connection};
		}
	}

	private return_conn(server_addr_str: string, conn: FcgiConn, reuse_connection: boolean)
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
		if (!reuse_connection || --conn.use_n_times<=0 || conn.use_till<=Date.now())
		{	conn.close();
		}
		else
		{	conn.request_till = 0;
			conns.idle.push(conn);
			this.n_idle_all++;
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

	private close_kept_alive_timed_out()
	{	let {conns_pool} = this;
		let now = Date.now();
		let want_stop = true;
		for (let [server_addr_str, {idle, busy, last_use_time}] of conns_pool)
		{	// Some request timed out?
			for (let i=busy.length-1; i>=0; i--)
			{	let conn = busy[i];
				debug_assert(conn.request_till > 0);
				if (conn.request_till <= now)
				{	this.return_conn(server_addr_str, conn, false);
				}
			}
			// Some idle connection is no longer needed?
			for (let i=idle.length-1; i>=0; i--)
			{	let conn = idle[i];
				debug_assert(conn.request_till == 0);
				if (conn.use_till <= now)
				{	idle.splice(i, 1);
					this.n_idle_all--;
					conn.close();
				}
			}
			//
			if (busy.length!=0 || idle.length!=0)
			{	want_stop = false;
			}
			else if (last_use_time+FORGET_CONNECTION_STATE_AFTER < now)
			{	conns_pool.delete(server_addr_str);
			}
		}
		if (want_stop)
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
						conn.close();
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
			conn.close();
			debug_assert(this.n_idle_all >= 0);
		}
	}
}
