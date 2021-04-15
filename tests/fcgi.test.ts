import {fcgi} from "../mod.ts";
import {map_to_obj, MockListener} from './mock/mod.ts';
import {SERVER_SOFTWARE, RequestOptions} from '../client.ts';
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
(	'Basic 2',
	async () =>
	{	const FILTERS = ['', '/page-1.html', '', '/page-3.html'];
		let server_error;
		fcgi.on('error', (e: any) => {server_error = e});
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
					assertEquals(map_to_obj(req.headers), i!=1 ? {'host': 'example.com'} : {'host': 'example.com', 'x-hello': 'All'});
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
					{	addr: listeners[i].addr
					};
					if (i == 1)
					{	request.scriptFilename = `/var/www/example.com/page-${i}.html`;
					}
					else if (i == 2)
					{	request.params = new Map([['SCRIPT_FILENAME', `/var/www/example.com/page-${i}.html`]]);
					}
					let response = await fcgi.fetch
					(	request,
						`http://example.com/page-${i}.html?i=${i}`,
						i!=1 ? undefined : {headers: new Headers(Object.entries({'X-Hello': 'All'}))}
					);
					assertEquals(response.status, 200);
					let data = '';
					if (response.body)
					{	for await (let chunk of response.body)
						{	data += new TextDecoder().decode(chunk);
						}
					}
					assertEquals(data, `Response body ${i}`);
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
