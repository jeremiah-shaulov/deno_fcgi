import {debug_assert} from './debug_assert.ts';
import {faddr_to_addr, addr_to_string} from './addr.ts';
import type {FcgiAddr} from './addr.ts';
import {FcgiConn} from "./fcgi_conn.ts";
import {SetCookies} from "./set_cookies.ts";

export const SERVER_SOFTWARE = 'DenoFcgi/0.0';
const DEFAULT_TIMEOUT = 10000;
const DEFAULT_KEEP_ALIVE_TIMEOUT = 10000;
const KEEPALIVE_CHECK_EACH = 1000;
const FORGET_CONNECTIONS_AFTER = 10*60*60*1000;

export interface RequestOptions
{	/** FastCGI service address. For example address of PHP-FPM service (what appears in "listen" directive in PHP-FPM pool configuration file). */
	addr: FcgiAddr,
	/** `scriptFilename` can be specified here, or in `params` under 'SCRIPT_FILENAME' key. Note that if sending to PHP-FPM, the response will be empty unless you provide this parameter. This parameter must contain PHP script file name. */
	scriptFilename?: string,
	/** Additional parameters to send to FastCGI server. If sending to PHP, they will be found in $_SERVER. If `params` object is given, it will be modified - `scriptFilename` and parameters inferred from request URL will be added to it. */
	params?: Map<string, string>,
	keepAliveTimeout?: number,
	keepAliveMax?: number,
	timeout?: number,
	/** Handler for errors logged from the requested service. */
	onLogError?: (error: string) => void,
}

export class ResponseWithCookies extends Response
{	constructor(body?: BodyInit|null|undefined, init?: ResponseInit|undefined, public cookies = new SetCookies)
	{	super(body, init);
	}
}

class FcgiConns
{	public all: FcgiConn[] = [];
	public supports_reuse_connection = true; // set to false after first unsuccessful attempt
	public n_in_use = 0;
	public last_use_time = Date.now();
}

export class Client
{	private conns_pool = new Map<string, FcgiConns>();
	private n_in_use_all = 0;
	private h_timer: number | undefined;

	async fetch(server_options: RequestOptions, input: Request|URL|string, init?: RequestInit): Promise<ResponseWithCookies>
	{	let {addr, scriptFilename, params, keepAliveTimeout, keepAliveMax, timeout, onLogError} = server_options;
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
		var {conn, supports_reuse_connection} = await this.get_conn(server_addr_str, server_addr, keepAliveTimeout, keepAliveMax);
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
						var {conn} = await this.get_conn(server_addr_str, server_addr, keepAliveTimeout, keepAliveMax);
						continue;
					}
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
		let h_timeout = setTimeout(() => {this.return_conn(server_addr_str, conn, false)}, timeout || DEFAULT_TIMEOUT);
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
						{	clearTimeout(h_timeout);
							that.return_conn(server_addr_str, conn, supports_reuse_connection);
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

	async fetch_capabilities(addr: FcgiAddr)
	{	let server_addr = faddr_to_addr(addr);
		let server_addr_str = addr_to_string(server_addr);
		let {conn} = await this.get_conn(server_addr_str, server_addr, 0, 1);
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

	private get_conns(server_addr_str: string)
	{	let conns = this.conns_pool.get(server_addr_str);
		if (!conns)
		{	conns = new FcgiConns;
			this.conns_pool.set(server_addr_str, conns);
		}
		return conns;
	}

	private async get_conn(server_addr_str: string, server_addr: Deno.Addr, keepAliveTimeout?: number, keepAliveMax?: number)
	{	let conns = this.get_conns(server_addr_str);
		debug_assert(conns.n_in_use>=0 && this.n_in_use_all>=0);
		conns.n_in_use++;
		this.n_in_use_all++;
		let {all, supports_reuse_connection} = conns;
		while (true)
		{	let conn = all.pop();
			if (!conn)
			{	conn = new FcgiConn(await Deno.connect(server_addr as any));
			}
			else if (conn.use_till <= Date.now())
			{	conn.close();
				continue;
			}
			conn.use_till = Math.min(conn.use_till, Date.now()+(keepAliveTimeout || DEFAULT_KEEP_ALIVE_TIMEOUT));
			if (keepAliveMax)
			{	conn.use_n_times = Math.min(conn.use_n_times, keepAliveMax);
			}
			conn.is_in_use = true;
			if (this.h_timer == undefined)
			{	this.h_timer = setInterval(() => {this.close_kept_alive_timed_out()}, KEEPALIVE_CHECK_EACH);
			}
			return {conn, supports_reuse_connection};
		}
	}

	private return_conn(server_addr_str: string, conn: FcgiConn, reuse_connection: boolean)
	{	let conns = this.conns_pool.get(server_addr_str);
		debug_assert(conns);
		conns.n_in_use--;
		this.n_in_use_all--;
		debug_assert(conns.n_in_use>=0 && this.n_in_use_all>=0);
		if (!reuse_connection || --conn.use_n_times<=0 || conn.use_till<=Date.now())
		{	conn.close();
		}
		else
		{	conn.is_in_use = false;
			conns.all.push(conn);
		}
		if (this.n_in_use_all == 0)
		{	this.close_kept_alive_timed_out();
		}
	}

	private close_kept_alive_timed_out()
	{	let {conns_pool} = this;
		let now = Date.now();
		let want_stop = true;
		for (let [server_addr_str, {all, n_in_use, last_use_time}] of conns_pool)
		{	for (let i=all.length-1; i>=0; i--)
			{	let conn = all[i];
				if (!conn.is_in_use && conn.use_till<=now)
				{	all.splice(i, 1);
					conn.close();
				}
			}
			if (n_in_use!=0 || all.length!=0)
			{	want_stop = false;
			}
			else if (last_use_time+FORGET_CONNECTIONS_AFTER < now)
			{	conns_pool.delete(server_addr_str);
			}
		}
		if (want_stop)
		{	clearInterval(this.h_timer);
			this.h_timer = undefined;
		}
	}
}
