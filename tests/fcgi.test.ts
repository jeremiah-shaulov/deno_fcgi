import {fcgi} from "../fcgi.ts";
import {ProtocolError} from '../error.ts';
import {map_to_obj, MockListener, MockFcgiConn} from './mock/mod.ts';
import {SERVER_SOFTWARE, RequestOptions} from '../client.ts';
import {RECYCLE_REQUEST_ID_AFTER} from '../fcgi_conn.ts';
import {SetCookies} from '../set_cookies.ts';
import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {writeAll, readAll} from 'https://deno.land/std/io/util.ts';
import {sleep} from "https://deno.land/x/sleep/mod.ts";

Deno.test
(	'Basic',
	async () =>
	{	let listener = new MockListener;
		let conn = listener.pend_accept(1024, -1, 'no');
		let server_error: Error | undefined;
		fcgi.on('error', (e: Error) => {server_error = e});
		// write
		conn.pend_read_fcgi_begin_request(1, 'responder', false);
		conn.pend_read_fcgi_params(1, {a: '1'});
		conn.pend_read_fcgi_stdin(1, 'Body');
		// accept
		fcgi.listen
		(	listener,
			'',
			async req =>
			{	await req.post.parse();
				await req.respond({body: 'Response body'});
				fcgi.unlisten();
			}
		);
		await fcgi.on('end');
		// read
		assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\nResponse body');
		assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
		assertEquals(conn.take_written_fcgi(), undefined);
		// check
		assert(!server_error);
	}
);

Deno.test
(	'404',
	async () =>
	{	let listener = new MockListener;
		let conn = listener.pend_accept(1024, -1, 'no');
		let server_error: Error | undefined;
		fcgi.on('error', (e: Error) => {server_error = e});
		let n_requests = 0;
		// write request 1
		conn.pend_read_fcgi_begin_request(1, 'responder', true);
		conn.pend_read_fcgi_params(1, {REQUEST_URI: '/hello'});
		conn.pend_read_fcgi_stdin(1, 'Body 1');
		// write request 2
		conn.pend_read_fcgi_begin_request(2, 'responder', true);
		conn.pend_read_fcgi_params(2, {REQUEST_URI: '/page'});
		conn.pend_read_fcgi_stdin(2, 'Body 2');
		// accept
		fcgi.listen
		(	listener,
			'/page',
			async req =>
			{	n_requests++;
				await req.post.parse();
				await req.respond({body: 'Response body 2'});
				fcgi.unlisten();
			}
		);
		await fcgi.on('end');
		// read
		assertEquals(conn.take_written_fcgi_stdout(1), 'status: 404\r\n\r\nResource not found');
		assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
		assertEquals(conn.take_written_fcgi_stdout(2), 'status: 200\r\n\r\nResponse body 2');
		assertEquals(conn.take_written_fcgi_end_request(2), 'request_complete');
		assertEquals(conn.take_written_fcgi(), undefined);
		// check
		assert(!server_error);
		assertEquals(n_requests, 1);
	}
);

Deno.test
(	'Header across buffer boundary',
	async () =>
	{	for (let [chunk_size, strlen] of [[12, 3000], [123, 123]])
		{	const LONG_STR = '*'.repeat(strlen);
			let conn = new MockFcgiConn(chunk_size, -1, 'full');
			conn.pend_read_fcgi_stdout(1, `Status: 403\r\nContent-Type: text/junk\r\nX-Hello: "a\rb\nc"\r\nX-Long: ${LONG_STR}\r\n\r\nResponse body`);
			conn.pend_read_fcgi_end_request(1, 'request_complete');
			let response = await fcgi.fetch({addr: conn}, `http://example.com/`, {body: 'Request body'});
			// check request
			assertEquals(conn.take_written_fcgi_begin_request(1), {role: 'responder', keep_conn: true});
			assertEquals(map_to_obj(await conn.take_written_fcgi_params(1)), {HTTP_HOST: 'example.com', QUERY_STRING: '', REQUEST_METHOD: 'GET', REQUEST_SCHEME: 'http', REQUEST_URI: '/', SERVER_SOFTWARE});
			assertEquals(conn.take_written_fcgi_stdin(1), 'Request body');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check response
			assertEquals(response.status, 403);
			assertEquals(await response.text(), 'Response body');
			assertEquals(map_to_obj(response.headers), {'content-type': 'text/junk', 'x-long': LONG_STR});
		}
	}
);

Deno.test
(	'More than RECYCLE_REQUEST_ID_AFTER requests within connection',
	async () =>
	{	const N_REQUESTS = RECYCLE_REQUEST_ID_AFTER + 1;
		let server_error;
		fcgi.on('error', (e: any) => {console.error(e); server_error = e});
		// accept
		let n_request = 0;
		let listener = fcgi.listen
		(	0,
			'',
			async req =>
			{	await req.respond();
				if (++n_request >= N_REQUESTS)
				{	fcgi.unlisten(listener.addr);
				}
			}
		);
		// query
		for (let i=0; i<N_REQUESTS; i++)
		{	let response = await fcgi.fetch
			(	{	addr: listener.addr,
					keepAliveMax: N_REQUESTS,
					keepAliveTimeout: 5*60*1000,
				},
				`https://example.com/page.html`
			);
			assertEquals(response.status, 200);
			assertEquals(await response.text(), '');
		}
		assert(!server_error);
	}
);

Deno.test
(	'stderr',
	async () =>
	{	const N_REQUESTS = 2;
		let server_error;
		fcgi.on('error', (e: any) => {console.error(e); server_error = e});
		// accept
		let n_request = 0;
		let listener = fcgi.listen
		(	0,
			'',
			async req =>
			{	req.logError(`Message ${n_request}.a`);
				req.logError(`Message ${n_request}.b`);
				await req.respond({body: 'Response body'});
				if (++n_request >= N_REQUESTS)
				{	fcgi.unlisten(listener.addr);
				}
			}
		);
		// query
		for (let i=0; i<N_REQUESTS; i++)
		{	let messages: string[] = [];
			let response = await fcgi.fetch
			(	{	addr: listener.addr,
					keepAliveMax: N_REQUESTS,
					onLogError(message)
					{	messages.push(message);
					}
				},
				`https://example.com/page.html`
			);
			assertEquals(response.status, 200);
			assertEquals(await response.text(), 'Response body');
			assertEquals(messages, [`Message ${i}.a`, `Message ${i}.b`]);
		}
		assert(!server_error);
	}
);

Deno.test
(	'Protocol error',
	async () =>
	{	let listener_1 = new MockListener;
		let listener_2 = new MockListener;
		let conn_1 = listener_1.pend_accept(1024, -1, 'no');
		let conn_2 = listener_2.pend_accept(1024, -1, 'no');
		let was_request = false;
		let n_errors = 0;
		let server_error: Error | undefined;
		fcgi.on('error', (e: Error) => {server_error = e; n_errors++});
		// write request 1 (protocol error)
		conn_1.pend_read_fcgi_begin_request(1, 'responder', true);
		conn_1.currupt_last_bytes(1);
		// write request 2
		conn_2.pend_read_fcgi_begin_request(1, 'responder', true);
		conn_2.pend_read_fcgi_params(1, {id: 'req 2'});
		conn_2.pend_read_fcgi_stdin(1, 'Body 2');
		// accept
		fcgi.listen
		(	listener_1,
			'',
			async req =>
			{	was_request = true;
			}
		);
		fcgi.listen
		(	listener_2,
			'',
			async req =>
			{	assertEquals(map_to_obj(req.params), {id: 'req 2'});
				assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body 2');
				await req.respond({body: 'Hello'});
				fcgi.unlisten();
			}
		);
		await fcgi.on('end');
		// read
		assertEquals(conn_2.take_written_fcgi_stdout(1), 'status: 200\r\n\r\nHello');
		assertEquals(conn_2.take_written_fcgi_end_request(1), 'request_complete');
		assertEquals(conn_2.take_written_fcgi(), undefined);
		// check
		assert(!was_request);
		assertEquals(n_errors, 1);
		assert(server_error instanceof ProtocolError);
	}
);

Deno.test
(	'Parallel requests',
	async () =>
	{	const FILTERS = ['', '/page-1.html', '', '/page-3.html'];
		let server_error;
		fcgi.on('error', (e: any) => {console.error(e); server_error = e});
		fcgi.options({keepAliveMax: 1, maxConns: FILTERS.length});
		// accept
		let listeners: Deno.Listener[] = [];
		for (let i=0; i<FILTERS.length; i++)
		{	listeners[i] = fcgi.listen
			(	0,
				FILTERS[i],
				async req =>
				{	await req.post.parse();
					assertEquals(req.params.get('REQUEST_METHOD'), 'GET');
					assertEquals(req.params.get('REQUEST_SCHEME'), 'http');
					assertEquals(req.params.get('HTTP_HOST'), 'example.com');
					assertEquals(req.params.get('REQUEST_URI'), `/page-${i}.html?i=${i}`);
					assertEquals(req.params.get('QUERY_STRING'), `i=${i}`);
					assertEquals(req.params.get('SERVER_SOFTWARE'), SERVER_SOFTWARE);
					assertEquals(req.params.get('SCRIPT_FILENAME'), i==1 || i==2 ? `/var/www/example.com/page-${i}.html` : undefined);
					assertEquals(req.get.get('i'), i+'');
					assertEquals(map_to_obj(req.headers), i==1 ? {'host': 'example.com', 'x-hello': 'All'} : i==2 ? {'host': 'example.com', 'cookie': 'coo-1= val <1> ; coo-2=val <2>.'} : {'host': 'example.com'});
					if (i == 2)
					{	assertEquals(map_to_obj(req.cookies), {'coo-1': ' val <1> ', 'coo-2': 'val <2>.'});
					}
					if (i != FILTERS.length-1)
					{	await sleep(1); // i want all the requests to accumulate, and test `fcgi.canFetch()`
					}
					await req.respond({body: `Response body ${i}`});
					fcgi.unlisten(listeners[i].addr);
				}
			);
		}
		// query
		assert(fcgi.canFetch());
		let promises = [];
		for (let i=0; i<FILTERS.length; i++)
		{	promises[promises.length] = Promise.resolve().then
			(	async () =>
				{	let request: RequestOptions =
					{	addr: listeners[i].addr
					};
					if (i == 1)
					{	request.scriptFilename = `/var/www/example.com/page-${i}.html`;
					}
					else if (i == 2)
					{	request.params = new Map(Object.entries({SCRIPT_FILENAME: `/var/www/example.com/page-${i}.html`, HTTP_COOKIE: 'coo-1= val <1> ; coo-2=val <2>.'}));
					}
					let response = await fcgi.fetch
					(	request,
						`http://example.com/page-${i}.html?i=${i}`,
						i!=1 ? undefined : {headers: new Headers(Object.entries({'X-Hello': 'All'}))}
					).then
					(	async response =>
						{	if (i == FILTERS.length-1)
							{	assert(!fcgi.canFetch());
								for (let i=0; i<1000 && !fcgi.canFetch(); i++)
								{	await fcgi.pollCanFetch();
								}
								assert(fcgi.canFetch());
								await fcgi.pollCanFetch();
								assert(fcgi.canFetch());
							}
							return response;
						}
					);
					assertEquals(response.status, 200);
					assertEquals(!response.body ? '' : new TextDecoder().decode(await readAll(response.body)), `Response body ${i}`);
				}
			);
		}
		let was_end = false;
		await fcgi.on('end', () => {was_end = true});
		await Promise.all(promises);
		assert(was_end);
		assert(!server_error);
		fcgi.off('error');
	}
);

Deno.test
(	'Sequential requests',
	async () =>
	{	let N_REQUESTS = 4;
		const SET_COOKIE_OPTIONS = {domain: 'example.com', path: '/', httpOnly: true, secure: true, sameSite: 'None'};
		let server_error;
		let onerror = (e: any) => {console.error(e); server_error = e};
		fcgi.on('error', onerror);
		// accept
		let n_accepted = 0;
		let listener = fcgi.listen
		(	0,
			'',
			async req =>
			{	let i = n_accepted;
				await req.post.parse();
				assertEquals(req.params.get('REQUEST_METHOD'), 'POST');
				assertEquals(req.params.get('REQUEST_SCHEME'), 'https');
				assertEquals(req.params.get('HTTP_HOST'), 'example.com');
				assertEquals(req.params.get('REQUEST_URI'), `/page-${i}.html?i=${i}`);
				assertEquals(req.params.get('QUERY_STRING'), `i=${i}`);
				assertEquals(req.params.get('SERVER_SOFTWARE'), SERVER_SOFTWARE);
				assertEquals(req.params.get('SCRIPT_FILENAME'), `/var/www/example.com/page-${i}.html`);
				assertEquals(req.get.get('i'), i+'');
				assertEquals(map_to_obj(req.headers), {'host': 'example.com', 'x-hello': 'All'});
				assertEquals(req.post.get('par'), 'val'+i);
				req.cookies.set('coo-1', ' val <1> ');
				req.cookies.set('coo-2', 'val <2>.', SET_COOKIE_OPTIONS);
				await req.respond({body: `Response body ${i}`});
				if (++n_accepted >= N_REQUESTS)
				{	fcgi.unlisten(listener.addr);
				}
			}
		);
		// query
		for (let i=0; i<N_REQUESTS; i++)
		{	let response = await fcgi.fetch
			(	{	addr: listener.addr,
					keepAliveMax: N_REQUESTS,
					scriptFilename: `/var/www/example.com/page-${i}.html`,
				},
				`https://example.com/page-${i}.html?i=${i}`,
				{	method: 'post',
					headers: new Headers(Object.entries({'Content-Type': 'application/x-www-form-urlencoded', 'X-Hello': 'All'})),
					body: `par=val${i}`
				}
			);
			assertEquals(response.status, 200);
			assertEquals(map_to_obj(response.cookies), {'coo-1': {value: ' val <1> ', options: {}}, 'coo-2': {value: 'val <2>.', options: SET_COOKIE_OPTIONS}});
			assertEquals(await response.text(), `Response body ${i}`);
		}
		assert(!server_error);
		fcgi.off('error', onerror);
	}
);

Deno.test
(	'Exception',
	async () =>
	{	let N_REQUESTS = 3;
		let server_error: Error | undefined;
		fcgi.on('error', (e: any) => {server_error = e});
		// accept
		let n_accepted = 0;
		let listener;
		for (let i=0; i<N_REQUESTS; i++)
		{	let lis = fcgi.listen
			(	listener?.addr ?? 0,
				'',
				async req =>
				{	let i = n_accepted++;
					if (i == 1)
					{	throw new Error('i is 1!');
					}
					await req.post.parse();
					assertEquals(req.params.get('REQUEST_METHOD'), 'POST');
					assertEquals(req.params.get('REQUEST_SCHEME'), 'https');
					assertEquals(req.params.get('HTTP_HOST'), 'example.com');
					assertEquals(req.params.get('REQUEST_URI'), `/page-${i}.html?i=${i}`);
					assertEquals(req.params.get('QUERY_STRING'), `i=${i}`);
					assertEquals(req.params.get('SERVER_SOFTWARE'), SERVER_SOFTWARE);
					assertEquals(req.params.get('SCRIPT_FILENAME'), `/var/www/example.com/page-${i}.html`);
					assertEquals(req.get.get('i'), i+'');
					assertEquals(map_to_obj(req.headers), {'host': 'example.com', 'x-hello': 'All'});
					assertEquals(req.post.get('par'), 'val'+i);
					req.cookies.set('coo-1', ' val <1> ');
					req.cookies.set('coo-2', 'val <2>.');
					await req.respond({body: `Response body ${i}`});
					if (n_accepted >= N_REQUESTS)
					{	fcgi.unlisten(lis.addr);
					}
				}
			);
			listener = lis;
		}
		assert(listener);
		// query
		for (let i=0; i<N_REQUESTS; i++)
		{	let response = await fcgi.fetch
			(	{	addr: listener.addr,
					keepAliveMax: N_REQUESTS,
					scriptFilename: `/var/www/example.com/page-${i}.html`,
				},
				`https://example.com/page-${i}.html?i=${i}`,
				{	method: 'post',
					headers: new Headers(Object.entries({'Content-Type': 'application/x-www-form-urlencoded', 'X-Hello': 'All'})),
					body: `par=val${i}`
				}
			);
			if (i != 1)
			{	assertEquals(response.status, 200);
				assertEquals(map_to_obj(response.cookies), {'coo-1': {value: ' val <1> ', options: {}}, 'coo-2': {value: 'val <2>.', options: {}}});
				assertEquals(await response.text(), `Response body ${i}`);
			}
			else
			{	assertEquals(response.status, 500);
				assertEquals(map_to_obj(response.cookies), {});
				assertEquals(await response.text(), '');
			}
		}
		fcgi.unlisten(listener.addr);
		await fcgi.on('end');
		assertEquals(server_error?.message, 'i is 1!');
		fcgi.off('error');
	}
);

Deno.test
(	'Unix-domain socket and UDP',
	async () =>
	{	const SOCK_NAME = '/tmp/deno-fcgi-test.sock';
		try
		{	await Deno.remove(SOCK_NAME);
		}
		catch
		{
		}
		let server_error;
		fcgi.on('error', (e: any) => {console.error(e); server_error = e});
		// UDP
		let error;
		try
		{	fcgi.listen({transport: 'udp', hostname: 'localhost', port: 0}, '', async () => {});
		}
		catch (e)
		{	error = e;
		}
		assert(error);
		// Unix-domain socket
		try
		{	// accept
			let listener = fcgi.listen
			(	SOCK_NAME,
				'',
				async req =>
				{	await req.post.parse();
					assertEquals(req.params.get('REQUEST_URI'), `/page.html`);
					await req.respond({body: `Response body`});
					fcgi.unlisten(listener.addr);
				}
			);
			// query
			let response = await fcgi.fetch
			(	{	addr: SOCK_NAME,
					keepAliveMax: 1,
					scriptFilename: `/var/www/example.com/page.html`,
				},
				`https://example.com/page.html`
			);
			assertEquals(response.status, 200);
			assertEquals(await response.text(), `Response body`);
			assert(!server_error);
		}
		finally
		{	try
			{	await Deno.remove(SOCK_NAME);
			}
			catch
			{
			}
			fcgi.off('error');
		}
	}
);

Deno.test
(	'Capabilities',
	async () =>
	{	let MAX_REQS = [1, 10, Number.MAX_SAFE_INTEGER];
		let server_error;
		fcgi.on('error', (e: any) => {console.error(e); server_error = e});
		let was_request = false;
		for (let i=0; i<MAX_REQS.length; i++)
		{	fcgi.options({maxConns: MAX_REQS[i]});
			// accept
			let listener = fcgi.listen
			(	0,
				'',
				async () =>
				{	was_request = true;
				}
			);
			// query
			let result = await fcgi.fetchCapabilities(listener.addr);
			assertEquals(result.FCGI_MAX_CONNS, MAX_REQS[i]);
			assertEquals(result.FCGI_MAX_REQS, MAX_REQS[i]);
			assertEquals(result.FCGI_MPXS_CONNS, 0);
			fcgi.unlisten();
			await fcgi.on('end');
		}
		assert(!was_request);
		assert(!server_error);
		fcgi.off('error');
	}
);

Deno.test
(	'Options',
	async () =>
	{	let res = fcgi.options({maxConns: 1});
		assertEquals(res.maxConns, 1);
		fcgi.listen(0, '', async () => {});
		res = fcgi.options({});
		assertEquals(res.maxConns, 1);
		res = fcgi.options({maxConns: 2, structuredParams: true, maxNameLength: 3, maxValueLength: 4, maxFileSize: 5});
		assertEquals(res.maxConns, 2);
		assert(res.structuredParams);
		assertEquals(res.maxNameLength, 3);
		assertEquals(res.maxValueLength, 4);
		assertEquals(res.maxFileSize, 5);
		res = fcgi.options({maxConns: 6, structuredParams: false, maxNameLength: 7, maxValueLength: 8, maxFileSize: 9});
		assertEquals(res.maxConns, 6);
		assert(!res.structuredParams);
		assertEquals(res.maxNameLength, 7);
		assertEquals(res.maxValueLength, 8);
		assertEquals(res.maxFileSize, 9);
		fcgi.unlisten();
		await fcgi.on('end');
		assertEquals(res.maxConns, 6);
		assert(!res.structuredParams);
		assertEquals(res.maxNameLength, 7);
		assertEquals(res.maxValueLength, 8);
		assertEquals(res.maxFileSize, 9);
		res = fcgi.options({maxConns: 10, structuredParams: true, maxNameLength: 11, maxValueLength: 12, maxFileSize: 13});
		assertEquals(res.maxConns, 10);
		assert(res.structuredParams);
		assertEquals(res.maxNameLength, 11);
		assertEquals(res.maxValueLength, 12);
		assertEquals(res.maxFileSize, 13);
	}
);
