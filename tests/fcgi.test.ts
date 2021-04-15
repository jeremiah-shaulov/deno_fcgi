import {fcgi} from "../mod.ts";
import {TEST_CHUNK_SIZES, map_to_obj, MockListener, MockFcgiConn, MockConn} from './mock/mod.ts';
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
	{	const N_LISTENERS = 4;
		let server_error;
		fcgi.on('error', (e: any) => {server_error = e});
		// accept
		let listeners: Deno.Listener[] = [];
		for (let i=0; i<N_LISTENERS; i++)
		{	listeners[i] = fcgi.listen
			(	0,
				'',
				async req =>
				{	await req.post.parse();
					assertEquals(req.params.get('HTTP_HOST'), 'example.com');
					assertEquals(req.get.get('i'), i+'');
					await req.respond({body: `Response body ${i}`});
					fcgi.unlisten(listeners[i].addr);
				}
			);
		}
		// query
		let promises = [];
		for (let i=0; i<N_LISTENERS; i++)
		{	promises[promises.length] = Promise.resolve().then
			(	async () =>
				{	let response = await fcgi.fetch
					(	{	addr: listeners[i].addr
						},
						`http://example.com/?i=${i}`
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
		await fcgi.on('end');
		await Promise.all(promises);
		assert(!server_error);
	}
);
