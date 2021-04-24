import {fcgi} from "../mod.ts";
import {map_to_obj, MockListener} from './mock/mod.ts';
import {SERVER_SOFTWARE, RequestOptions} from '../client.ts';
import {SetCookies} from '../set_cookies.ts';
import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";

Deno.test
(	'Basic',
	async () =>
	{	let listener = new MockListener;
		let conn = listener.pend_accept(1024, -1, false);
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
	}
);

Deno.test
(	'Parallel requests',
	async () =>
	{	const FILTERS = ['', '/page-1.html', '', '/page-3.html'];
		let server_error;
		fcgi.on('error', (e: any) => {console.error(e); server_error = e});
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
					await req.respond({body: `Response body ${i}`});
					fcgi.unlisten(listeners[i].addr);
				}
			);
		}
		// query
		let promises = [];
		for (let i=0; i<FILTERS.length; i++)
		{	promises[promises.length] = Promise.resolve().then
			(	async () =>
				{	let request: RequestOptions =
					{	addr: listeners[i].addr,
						keepAliveMax: 1,
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
					);
					assertEquals(response.status, 200);
					assertEquals(await response.text(), `Response body ${i}`);
				}
			);
		}
		let was_end = false;
		await fcgi.on('end', () => {was_end = true});
		await Promise.all(promises);
		assert(was_end);
		assert(!server_error);
	}
);

Deno.test
(	'Sequential requests',
	async () =>
	{	let N_REQUESTS = 4;
		const SET_COOKIE_OPTIONS = {domain: 'example.com', path: '/', httpOnly: true, secure: true, sameSite: 'None'};
		let server_error;
		fcgi.on('error', (e: any) => {console.error(e); server_error = e});
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
	}
);

Deno.test
(	'Unix-domain socket and UDP',
	async () =>
	{	const SOCK_NAME = '/tmp/deno-fcgi-test.sock';
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
			{	Deno.remove(SOCK_NAME);
			}
			catch
			{
			}
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
