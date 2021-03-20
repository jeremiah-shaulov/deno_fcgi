import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {exists} from "https://deno.land/std/fs/mod.ts";
import {TEST_CHUNK_SIZES, map_to_obj, MockListener, MockFcgiConn} from './mock/mod.ts';
import {Server} from "../server.ts";
import {AbortedError, TerminatedError, ProtocolError} from '../error.ts';

function *test_connections(): Generator<MockFcgiConn>
{	for (let chunk_size of TEST_CHUNK_SIZES)
	{	for (let i=0; i<4; i++)
		{	yield new MockFcgiConn(chunk_size, i%2==0, i>=2);
		}
	}
}

Deno.test
(	'Basic request',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
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
				Deno.writeAll(req, new TextEncoder().encode('Response body'));
				await req.respond();
				assertEquals(server.nAccepted(), 0);
				// try to use terminated request
				let error;
				try
				{	await req.respond({body: 'Response body'});
				}
				catch (e)
				{	error = e;
				}
				assert(error instanceof TerminatedError);
				break;
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\nx-hello: all\r\n\r\nResponse body');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(1), undefined);
		}
	}
);

Deno.test
(	'Respond without reading POST',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', false);
			conn.pend_read_fcgi_params(1, {HELLO: 'all'});
			conn.pend_read_fcgi_stdin(1, 'Body');
			// accept
			for await (let req of server)
			{	assertEquals(map_to_obj(req.params), {HELLO: 'all'});
				assertEquals(server.nAccepted(), 1);
				await req.respond({body: 'Response body', headers: new Headers(Object.entries({'X-Hello': 'all'})), status: 404});
				assertEquals(server.nAccepted(), 0);
				break;
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 404\r\nx-hello: all\r\n\r\nResponse body');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(1), undefined);
		}
	}
);

Deno.test
(	'Cookies',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', false);
			conn.pend_read_fcgi_params(1, {HTTP_COOKIE: 'coo-1="val <1>"; coo-2=val <2>.'});
			conn.pend_read_fcgi_stdin(1, '');
			// accept
			for await (let req of server)
			{	assertEquals(req.cookies.size, 2);
				assertEquals(req.cookies.get('coo-1'), 'val <1>');
				assertEquals(req.cookies.get('coo-2'), 'val <2>.');
				req.cookies.set('coo-1', 'New value', {domain: 'example.com'});
				await req.respond();
				assertEquals(req.cookies.size, 2);
				req.cookies.clear();
				assertEquals(req.cookies.size, 0);
				break;
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\nset-cookie: coo-1=New%20value; Domain=example.com\r\n\r\n');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(1), undefined);
		}
	}
);

Deno.test
(	'Abort request',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
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
				assert(error instanceof AbortedError);
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
				assert(error instanceof AbortedError);
				// try to use terminated request
				error = undefined;
				try
				{	await req.respond({body: 'Response body'});
				}
				catch (e)
				{	error = e;
				}
				assert(error instanceof TerminatedError);
				// done
				break;
			}
		}
	}
);
