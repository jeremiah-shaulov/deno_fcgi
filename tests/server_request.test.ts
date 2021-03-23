import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {exists} from "https://deno.land/std/fs/mod.ts";
import {TEST_CHUNK_SIZES, map_to_obj, MockListener, MockFcgiConn} from './mock/mod.ts';
import {Server} from "../server.ts";
import {AbortedError, TerminatedError, ProtocolError} from '../error.ts';

function *test_connections(only_chunk_sizes?: number[]): Generator<MockFcgiConn>
{	for (let chunk_size of only_chunk_sizes || TEST_CHUNK_SIZES)
	{	for (let i=0; i<4; i++)
		{	yield new MockFcgiConn(chunk_size, i%2==0, i>=2);
		}
	}
}

function get_random_bytes(length: number)
{	let buffer = new Uint8Array(length);
	for (let i=0; i<buffer.length; i++)
	{	buffer[i] = 32 + Math.floor(Math.random()*90);
	}
	return buffer;
}

function get_random_string(length: number)
{	return new TextDecoder().decode(get_random_bytes(length));
}

Deno.test
(	'Basic request',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.on('error', e => {server_error = e});
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
			assert(!server_error);
		}
	}
);

Deno.test
(	'Basic request 2',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.on('error', e => {server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', false);
			conn.pend_read_fcgi_stdin(1, 'Body');
			// accept
			for await (let req of server)
			{	assertEquals(req.params.size, 0);
				assertEquals(server.nAccepted(), 1);
				let body = new TextEncoder().encode('Response body');
				req.responseStatus = 500;
				await req.respond({body});
				assertEquals(server.nAccepted(), 0);
				break;
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 500\r\n\r\nResponse body');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(1), undefined);
			assert(!server_error);
		}
	}
);

Deno.test
(	'Respond without reading POST',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.on('error', e => {server_error = e});
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
			assert(!server_error);
		}
	}
);

Deno.test
(	'Cookies',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.on('error', e => {server_error = e});
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
			assert(!server_error);
		}
	}
);

Deno.test
(	'Abort request',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.on('error', e => {server_error = e});
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
			assert(!server_error);
		}
	}
);

Deno.test
(	'Reuse connection',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.on('error', e => {server_error = e});
			// write request 1
			conn.pend_read_fcgi_begin_request(1, 'responder', true);
			conn.pend_read_fcgi_params(1, {id: 'req 1'});
			conn.pend_read_fcgi_stdin(1, 'Body 1');
			// write request 2
			conn.pend_read_fcgi_begin_request(2, 'responder', true);
			conn.pend_read_fcgi_params(2, {id: 'req 2'});
			conn.pend_read_fcgi_stdin(2, 'Body 2');
			// accept
			let i = 1;
			for await (let req of server)
			{	assertEquals(map_to_obj(req.params), {id: 'req '+i});
				assertEquals(new TextDecoder().decode(await Deno.readAll(req.body)), 'Body '+i);
				assertEquals(server.nAccepted(), 1);
				assertEquals(server.nProcessing(), 1);
				await req.respond();
				assertEquals(server.nAccepted(), 1);
				assertEquals(server.nProcessing(), 0);
				if (++i > 2)
				{	break;
				}
			}
			assert(!server_error);
		}
	}
);

Deno.test
(	'Broken connection',
	async () =>
	{	let conn = new MockFcgiConn(21, true, false);
		let listener = new MockListener([conn]);
		let server = new Server(listener);
		// write
		conn.pend_read_fcgi_begin_request(1, 'responder', true);
		conn.pend_read_fcgi_params(1, {a: '1'});
		conn.pend_read_fcgi_stdin(1, 'Body 1');
		// accept
		for await (let req of server)
		{	assertEquals(map_to_obj(req.params), {a: '1'});
			conn.close();
			let error;
			try
			{	await Deno.readAll(req.body);
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Request already terminated');
			assert(error instanceof TerminatedError);
			assertEquals(server.nAccepted(), 0);
			assertEquals(server.nProcessing(), 0);
			break;
		}
	}
);

Deno.test
(	'Params: maxNameLength',
	async () =>
	{	for (let maxNameLength of [1, 2, 3, 8*1024, 0xFFF8, 0xFFFF])
		{	for (let conn of test_connections([2, 12, 13]))
			{	let str_err = get_random_string(maxNameLength+1);
				let str_ok = str_err.slice(0, -1);
				let listener = new MockListener([conn]);
				let server = new Server(listener, {maxNameLength});
				let server_error;
				server.on('error', e => {server_error = e});
				// write
				conn.pend_read_fcgi_begin_request(1, 'responder', true);
				conn.pend_read_fcgi_params(1, {[str_ok]: 'ok', [str_err]: 'err'});
				conn.pend_read_fcgi_stdin(1, '');
				// accept
				for await (let req of server)
				{	assertEquals(req.params.size, 1);
					assertEquals(req.params.get(str_ok), 'ok');
					assertEquals((await Deno.readAll(req.body)).length, 0);
					await req.respond();
					break;
				}
				assert(!server_error);
			}
		}
	}
);

Deno.test
(	'Params: maxValueLength',
	async () =>
	{	for (let maxValueLength of [1, 2, 3, 8*1024, 0xFFF8, 0xFFFF])
		{	for (let conn of test_connections([2, 12, 13]))
			{	let str_err = get_random_string(maxValueLength+1);
				let str_ok = str_err.slice(0, -1);
				let listener = new MockListener([conn]);
				let server = new Server(listener, {maxValueLength});
				let server_error;
				server.on('error', e => {server_error = e});
				// write
				conn.pend_read_fcgi_begin_request(1, 'responder', true);
				conn.pend_read_fcgi_params(1, {'ok': str_ok, 'err': str_err});
				conn.pend_read_fcgi_stdin(1, '');
				// accept
				for await (let req of server)
				{	assertEquals(req.params.size, 1);
					assertEquals(req.params.get('ok'), str_ok);
					assertEquals((await Deno.readAll(req.body)).length, 0);
					await req.respond();
					break;
				}
				assert(!server_error);
			}
		}
	}
);

Deno.test
(	'Long body',
	async () =>
	{	for (let len of [1, 2, 3, 8*1024, 0xFFF8, 0xFFFF])
		{	for (let conn of test_connections([2, 12, 13]))
			{	let str_request = get_random_bytes(len);
				let str_response = get_random_string(len);
				let listener = new MockListener([conn]);
				let server = new Server(listener);
				let server_error;
				server.on('error', e => {server_error = e});
				// write
				conn.pend_read_fcgi_begin_request(1, 'responder', true);
				conn.pend_read_fcgi_params(1, {});
				conn.pend_read_fcgi_stdin(1, new TextDecoder().decode(str_request));
				// accept
				for await (let req of server)
				{	assertEquals((await Deno.readAll(req.body)), str_request);
					await req.respond({body: str_response});
					break;
				}
				// read
				assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n'+str_response);
				assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
				assertEquals(conn.take_written_fcgi(1), undefined);
				assert(!server_error);
			}
		}
	}
);

Deno.test
(	'Log error',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.on('error', e => {server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(2, 'responder', false);
			conn.pend_read_fcgi_params(2, {});
			conn.pend_read_fcgi_stdin(2, '');
			// accept
			for await (let req of server)
			{	assertEquals(req.params.size, 0);
				req.logError('Hello');
				await req.respond();
				break;
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(2, true), 'Hello\n');
			assertEquals(conn.take_written_fcgi_stdout(2), 'status: 200\r\n\r\n');
			assertEquals(conn.take_written_fcgi_stdout(2, true), '');
			assertEquals(conn.take_written_fcgi_end_request(2), 'request_complete');
			assertEquals(conn.take_written_fcgi(2), undefined);
			assert(!server_error);
		}
	}
);
