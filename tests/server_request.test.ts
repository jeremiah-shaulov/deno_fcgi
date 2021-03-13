import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {exists} from "https://deno.land/std/fs/mod.ts";
import {TEST_CHUNK_SIZES, map_to_obj, MockListener, MockFcgiConn} from './mock/mod.ts';
import {Server} from "../server.ts";

Deno.test
(	'Basic request',
	async () =>
	{	for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<4; i++)
			{	let conn = new MockFcgiConn(chunk_size, i%2==0, i>=2);
				let listener = new MockListener([conn]);
				let server = new Server(listener);
				// write
				conn.pend_read_fcgi_begin_request(1, 'responder', false);
				conn.pend_read_fcgi_params(1, {HELLO: 'all'});
				conn.pend_read_fcgi_stdin(1, 'Body');
				// accept
				for await (let req of server)
				{	assertEquals(map_to_obj(req.params), {HELLO: 'all'});
					assertEquals(new TextDecoder().decode(await Deno.readAll(req.body)), 'Body');
					assertEquals(server.nAccepted(), 1);
					req.responseHeaders.set('X-Hello', 'all');
					await req.respond({body: 'Response body'});
					assertEquals(server.nAccepted(), 0);
					// try to use terminated request
					let error;
					try
					{	await req.respond({body: 'Response body'});
					}
					catch (e)
					{	error = e;
					}
					assert(error);
					break;
				}
				// read
				assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\nx-hello: all\r\n\r\nResponse body');
				assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
				assertEquals(conn.take_written_fcgi(1), undefined);
			}
		}
	}
);

Deno.test
(	'Abort request',
	async () =>
	{	for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<4; i++)
			{	let conn = new MockFcgiConn(chunk_size, i%2==0, i>=2);
				let listener = new MockListener([conn]);
				let server = new Server(listener);
				// write
				conn.pend_read_fcgi_begin_request(1, 'responder', false);
				conn.pend_read_fcgi_params(1, {HELLO: 'all'});
				conn.pend_read_fcgi_abort_request(1);
				// accept
				for await (let req of server)
				{	assertEquals(map_to_obj(req.params), {HELLO: 'all'});
					// try  to read POST body
					let error;
					try
					{	await Deno.readAll(req.body);
					}
					catch (e)
					{	error = e;
					}
					assert(error);
					// must disconnect
					assertEquals(server.nAccepted(), 0);
					// try to respond
					error = undefined;
					try
					{	await req.respond();
					}
					catch (e)
					{	error = e;
					}
					assert(error);
					// done
					break;
				}
			}
		}
	}
);
