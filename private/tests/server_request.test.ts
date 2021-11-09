import {PathNode} from "../structured_map.ts";
import {Server} from '../server.ts';
import {AbortedError, TerminatedError, ProtocolError} from '../error.ts';
import {TEST_CHUNK_SIZES, get_random_bytes, get_random_string, map_to_obj, MockListener, MockFcgiConn, MockConn} from './mock/mod.ts';
import {writeAll, readAll} from '../deps.ts';
import {assert, assertEquals} from "https://deno.land/std@0.106.0/testing/asserts.ts";
import {sleep} from "https://deno.land/x/sleep@v1.2.0/mod.ts";

function *test_connections(only_chunk_sizes?: number[], full_split_stream_records=false): Generator<MockFcgiConn>
{	for (let chunk_size of only_chunk_sizes || TEST_CHUNK_SIZES)
	{	for (let i=0; i<4; i++)
		{	yield new MockFcgiConn(chunk_size, i%2==0 ? chunk_size%9 : -1, i<2 ? 'no' : full_split_stream_records ? 'full' : 'yes');
		}
	}
}

Deno.test
(	'Basic request',
	async () =>
	{	const PARAMS =
		{	HELLO: 'all',
			SERVER_PROTOCOL: 'HTTP/2'
		};
		for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', false);
			conn.pend_read_fcgi_params(1, PARAMS);
			conn.pend_read_fcgi_stdin(1, 'Body');
			// accept
			for await (let req of server)
			{	assertEquals(map_to_obj(req.params), PARAMS);
				assertEquals(req.proto, 'HTTP/2');
				assertEquals(req.protoMajor, 2);
				assertEquals(req.protoMinor, 0);
				assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body');
				assertEquals(server.nConnections(), 1);
				assertEquals(server.nRequests(), 1);
				req.responseHeaders.set('X-Hello', 'all');
				writeAll(req, new TextEncoder().encode('Response body'));
				await req.respond();
				// try to use terminated request
				let error;
				try
				{	await req.respond({body: 'Response body'});
				}
				catch (e)
				{	error = e;
				}
				assert(error instanceof TerminatedError);
				server.removeListeners();
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\nx-hello: all\r\n\r\nResponse body');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'Basic request 2, no params',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', true);
			conn.pend_read_fcgi_stdin(1, 'Body');
			// accept
			for await (let req of server)
			{	assertEquals(req.params.size, 0);
				assertEquals(server.nConnections(), 1);
				assertEquals(server.nRequests(), 1);
				let body = new TextEncoder().encode('Response body');
				req.responseStatus = 500;
				await req.respond({body});
				server.removeListeners();
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 500\r\n\r\nResponse body');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'Body as reader',
	async () =>
	{	const PARAMS =
		{	HELLO: 'all',
			SERVER_PROTOCOL: 'HTTP/3.4'
		};
		for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', false);
			conn.pend_read_fcgi_params(1, PARAMS);
			conn.pend_read_fcgi_stdin(1, '\r\n');
			// accept
			for await (let req of server)
			{	assertEquals(map_to_obj(req.params), PARAMS);
				assertEquals(req.proto, 'HTTP/3.4');
				assertEquals(req.protoMajor, 3);
				assertEquals(req.protoMinor, 4);
				assertEquals(new TextDecoder().decode(await readAll(req.body)), '\r\n');
				assertEquals(server.nConnections(), 1);
				let body = new MockConn('Response body');
				await req.respond({body, status: 404});
				server.removeListeners();
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 404\r\n\r\nResponse body');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'GET, POST',
	async () =>
	{	const PARAMS =
		{	QUERY_STRING: 'a=1&b=2&c',
			CONTENT_TYPE: 'multipart/form-data; junk=yes; boundary=------------------------bb61988d15b5a62e; hello=all',
		};
		const POST =
		(	`--------------------------bb61988d15b5a62e\r\n`+
			`Content-Disposition: form-data; name="a"\r\n`+
			`\r\n`+
			`Hello\r\n`+
			`--------------------------bb61988d15b5a62e\r\n`+
			`Content-Disposition: form-data; name="b"\r\n`+
			`\r\n`+
			`World\r\n`+
			`--------------------------bb61988d15b5a62e--\r\n`
		);
		for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', false);
			conn.pend_read_fcgi_params(1, PARAMS);
			conn.pend_read_fcgi_stdin(1, POST);
			// accept
			for await (let req of server)
			{	assertEquals(map_to_obj(req.params), PARAMS);
				assertEquals(req.proto, '');
				assertEquals(req.protoMajor, 0);
				assertEquals(req.protoMinor, 0);
				// get
				assertEquals(map_to_obj(req.get), {a: '1', b: '2', c: ''});
				assertEquals([...req.get.entries()], [['a', '1'], ['b', '2'], ['c', '']]);
				assertEquals([...req.get.keys()], ['a', 'b', 'c']);
				assertEquals([...req.get.values()], ['1', '2', '']);
				let get_entries: [string, PathNode][] = [];
				req.get.forEach
				(	(v: PathNode, k: string, map: Map<string, PathNode>) =>
					{	assertEquals(map, req.get);
						get_entries.push([k, v]);
					}
				);
				assertEquals(get_entries, [['a', '1'], ['b', '2'], ['c', '']]);
				assertEquals(req.get.get('a'), '1');
				assert(req.get.has('a'));
				assert(!req.get.has('A'));
				assertEquals(req.get.size, 3);
				req.get.delete('a');
				assert(!req.get.has('a'));
				assertEquals(req.get.size, 2);
				req.get.delete('a');
				assertEquals(req.get.size, 2);
				req.get.clear();
				assertEquals(req.get.size, 0);
				// post
				await req.post.parse();
				assertEquals(map_to_obj(req.post), {a: 'Hello', b: 'World'});
				//
				assertEquals(server.nConnections(), 1);
				writeAll(req, new TextEncoder().encode('Response body'));
				await req.respond();
				server.removeListeners();
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\nResponse body');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'Respond without reading POST',
	async () =>
	{	const PARAMS =
		{	HELLO: 'all',
			SERVER_PROTOCOL: 'HELLO.'
		};
		for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', false);
			conn.pend_read_fcgi_params(1, PARAMS);
			conn.pend_read_fcgi_stdin(1, 'Body');
			// accept
			for await (let req of server)
			{	assertEquals(map_to_obj(req.params), PARAMS);
				assertEquals(req.proto, 'HELLO.');
				assertEquals(req.protoMajor, 0);
				assertEquals(req.protoMinor, 0);
				assertEquals(server.nConnections(), 1);
				await req.respond({body: 'Response body', headers: new Headers(Object.entries({'X-Hello': 'all'})), status: 404});
				server.removeListeners();
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 404\r\nx-hello: all\r\n\r\nResponse body');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
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
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', false);
			conn.pend_read_fcgi_params(1, {HTTP_COOKIE: 'coo-1= val <1> ; coo-2=val <2>.'});
			conn.pend_read_fcgi_stdin(1, '');
			// accept
			for await (let req of server)
			{	assertEquals(req.cookies.size, 2);
				assertEquals(req.cookies.get('coo-1'), ' val <1> ');
				assertEquals(req.cookies.get('coo-2'), 'val <2>.');
				req.cookies.set('coo-1', 'New value', {domain: 'example.com'});
				await req.respond();
				assertEquals(req.cookies.size, 2);
				req.cookies.clear();
				assertEquals(req.cookies.size, 0);
				server.removeListeners();
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\nset-cookie: coo-1=New%20value; Domain=example.com\r\n\r\n');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
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
			server.onError(e => {console.error(e); server_error = e});
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
				assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body '+i);
				assertEquals(server.nConnections(), 1);
				assertEquals(server.nRequests(), 1);
				await req.respond();
				assertEquals(server.nConnections(), 1);
				if (++i > 2)
				{	server.removeListeners();
				}
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi_stdout(2), 'status: 200\r\n\r\n');
			assertEquals(conn.take_written_fcgi_end_request(2), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'Accept',
	async () =>
	{	let conn = new MockFcgiConn(1024, -1, 'full');
		let listener = new MockListener([conn]);
		let server = new Server(listener);
		let server_error;
		server.onError(e => {console.error(e); server_error = e});
		// write request 1
		conn.pend_read_fcgi_begin_request(1, 'responder', true);
		conn.pend_read_fcgi_params(1, {id: 'req 1'});
		conn.pend_read_fcgi_stdin(1, 'Body 1');
		// write request 2
		conn.pend_read_fcgi_begin_request(2, 'responder', true);
		conn.pend_read_fcgi_params(2, {id: 'req 2'});
		conn.pend_read_fcgi_stdin(2, 'Body 2');
		// accept 1
		let req_promise = server.accept();
		// try accepting simultaneously
		let error;
		try
		{	await server.accept();
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Busy: Another accept task is ongoing');
		assertEquals(server.nConnections(), 0);
		let req = await req_promise;
		// req 1
		assertEquals(map_to_obj(req.params), {id: 'req 1'});
		assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body 1');
		assertEquals(server.nConnections(), 1);
		assertEquals(server.nRequests(), 1);
		await req.respond();
		assertEquals(server.nConnections(), 1);
		// accept 2
		req = await server.accept();
		// req 2
		assertEquals(map_to_obj(req.params), {id: 'req 2'});
		assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body 2');
		assertEquals(server.nConnections(), 1);
		assertEquals(server.nRequests(), 1);
		await req.respond();
		assertEquals(server.nConnections(), 1);
		// stop accepting
		server.removeListeners();
		error = undefined;
		try
		{	await server.accept();
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Server shut down');
		// read
		assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n');
		assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
		assertEquals(conn.take_written_fcgi_stdout(2), 'status: 200\r\n\r\n');
		assertEquals(conn.take_written_fcgi_end_request(2), 'request_complete');
		assertEquals(conn.take_written_fcgi(), undefined);
		// check
		assert(!server_error);
		assertEquals(server.nConnections(), 0);
		assertEquals(server.nRequests(), 0);
	}
);

Deno.test
(	'User read error',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
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
				assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body '+i);
				assertEquals(server.nConnections(), 1);
				assertEquals(server.nRequests(), 1);
				if (i == 1)
				{	let body = new MockConn;
					body.close();
					let error;
					try
					{	await req.respond({body});
					}
					catch (e)
					{	error = e;
					}
					assert(error);
					assert(req.isTerminated());
				}
				else
				{	await req.respond();
				}
				assertEquals(server.nConnections(), 1);
				if (++i > 2)
				{	server.removeListeners();
				}
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi_stdout(2), 'status: 200\r\n\r\n');
			assertEquals(conn.take_written_fcgi_end_request(2), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'Abort request',
	async () =>
	{	let was_write_error = false;
		let was_log_error = false;
		for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write request 1 (abort after PARAMS)
			conn.pend_read_fcgi_begin_request(1, 'responder', true);
			conn.pend_read_fcgi_params(1, {id: 'req 1'});
			conn.pend_read_fcgi_abort_request(1);
			// write request 2 (abort in the middle of STDIN)
			conn.pend_read_fcgi_begin_request(2, 'responder', true);
			conn.pend_read_fcgi_params(2, {id: 'req 2'});
			conn.pend_read_fcgi_abort_request(2, 'Body 2');
			// write request 3 (abort after STDIN)
			conn.pend_read_fcgi_begin_request(3, 'responder', true);
			conn.pend_read_fcgi_params(3, {id: 'req 3'});
			conn.pend_read_fcgi_stdin(3, 'Body 3');
			conn.pend_read_fcgi_abort_request(3);
			// write request 4
			conn.pend_read_fcgi_begin_request(4, 'responder', true);
			conn.pend_read_fcgi_params(4, {id: 'req 4'});
			conn.pend_read_fcgi_stdin(4, 'Body 4');
			// accept
			let i = 1;
			for await (let req of server)
			{	assertEquals(map_to_obj(req.params), {id: 'req '+i});
				if (i < 4)
				{	// try to read POST body
					let error;
					try
					{	await readAll(req.body);
					}
					catch (e)
					{	error = e;
					}
					assert(error instanceof AbortedError || i==3);
					// try to write
					error = undefined;
					try
					{	await writeAll(req, new TextEncoder().encode('Response body'));
					}
					catch (e)
					{	error = e;
					}
					if (error instanceof AbortedError)
					{	was_write_error = true;
					}
					// try logError
					error = undefined;
					try
					{	req.logError('Hello');
					}
					catch (e)
					{	error = e;
					}
					if (error instanceof AbortedError)
					{	was_log_error = true;
					}
					// try to respond
					error = undefined;
					try
					{	await req.respond();
					}
					catch (e)
					{	error = e;
					}
					assert(error instanceof AbortedError);
					// must not disconnect
					assertEquals(server.nConnections(), 1);
					// try to use terminated request
					error = undefined;
					try
					{	await req.respond({body: 'Response body'});
					}
					catch (e)
					{	error = e;
					}
					assert(error instanceof TerminatedError);
					// try logError when terminated
					error = undefined;
					try
					{	req.logError('Hello');
					}
					catch (e)
					{	error = e;
					}
					assert(error instanceof TerminatedError);
				}
				else
				{	assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body '+i);
					assertEquals(server.nConnections(), 1);
					assertEquals(server.nRequests(), 1);
					await req.respond();
				}
				assertEquals(server.nConnections(), 1);
				// done
				if (++i > 4)
				{	server.removeListeners();
				}
			}
			// read
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi_end_request(2), 'request_complete');
			assertEquals(conn.take_written_fcgi_stdout(4), 'status: 200\r\n\r\n');
			assertEquals(conn.take_written_fcgi_end_request(4), 'request_complete');
			let rec;
			let stdout_3 = new Uint8Array;
			let end_3 = false;
			while ((rec = conn.take_written_fcgi(3)))
			{	if (rec.record_type_name == 'STDOUT')
				{	let tmp = new Uint8Array(stdout_3.length + rec.payload.length);
					tmp.set(stdout_3);
					tmp.set(rec.payload, stdout_3.length);
					stdout_3 = tmp;
				}
				else
				{	assertEquals(rec.record_type_name, 'END_REQUEST');
					end_3 = true;
				}
			}
			let stdout_3_str = new TextDecoder().decode();
			if (stdout_3_str)
			{	assertEquals(stdout_3_str, 'status: 200\r\n\r\nResponse body');
			}
			assert(end_3);
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
			assert(was_write_error);
			assert(was_log_error);
		}
	}
);

Deno.test
(	'Broken connection',
	async () =>
	{	let conn = new MockFcgiConn(21, 0, 'no');
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
			{	await readAll(req.body);
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Connection closed');
			server.removeListeners();
		}
		// check
		assertEquals(server.nConnections(), 0);
		assertEquals(server.nRequests(), 0);
	}
);

Deno.test
(	'Broken connection 2',
	async () =>
	{	let conn = new MockFcgiConn(999, 0, 'no');
		let listener = new MockListener([conn]);
		let server = new Server(listener);
		// write
		conn.pend_read_fcgi_begin_request(1, 'responder', true);
		conn.pend_read_fcgi_params(1, {a: '1'});
		conn.pend_read_fcgi_stdin(1, '');
		// accept
		for await (let req of server)
		{	assertEquals(map_to_obj(req.params), {a: '1'});
			conn.close();
			let error;
			try
			{	await req.respond();
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Connection closed');
			server.removeListeners();
		}
		// check
		assertEquals(server.nConnections(), 0);
		assertEquals(server.nRequests(), 0);
	}
);

Deno.test
(	'Broken connection 3',
	async () =>
	{	let conn = new MockFcgiConn(999, 0, 'no');
		let listener = new MockListener([conn]);
		let server = new Server(listener);
		// write (no stdin)
		conn.pend_read_fcgi_begin_request(1, 'responder', true);
		conn.pend_read_fcgi_params(1, {a: '1'});
		// accept
		for await (let req of server)
		{	assertEquals(map_to_obj(req.params), {a: '1'});
			let error;
			try
			{	await req.respond();
			}
			catch (e)
			{	error = e;
			}
			assertEquals(error?.message, 'Unexpected end of input');
			server.removeListeners();
		}
		// check
		assertEquals(server.nConnections(), 0);
		assertEquals(server.nRequests(), 0);
	}
);

Deno.test
(	'Close server',
	async () =>
	{	let conn = new MockFcgiConn(999, 0, 'no');
		let listener = new MockListener([conn]);
		let server = new Server(listener);
		// write
		conn.pend_read_fcgi_begin_request(1, 'responder', true);
		conn.pend_read_fcgi_params(1, {a: '1'});
		conn.pend_read_fcgi_stdin(1, 'Body 1');
		// accept
		for await (let req of server)
		{	assertEquals(map_to_obj(req.params), {a: '1'});
			server.close();
			let error;
			try
			{	await readAll(req.body); // may not fail if data was in buffer before calling close()
			}
			catch (e)
			{	error = e;
			}
			let error_2;
			try
			{	await req.respond();
			}
			catch (e)
			{	error_2 = e;
			}
			assert((error || error_2) instanceof TerminatedError);
			server.removeListeners();
		}
		// check
		assertEquals(server.nRequests(), 0);
		assertEquals(server.nConnections(), 0);
	}
);

Deno.test
(	'Close server before yielding a request',
	async () =>
	{	let conn = new MockFcgiConn(999, 0, 'no');
		let listener = new MockListener([conn]);
		let server = new Server(listener);
		// write
		conn.pend_read_fcgi_begin_request(1, 'responder', true);
		conn.pend_read_fcgi_params(1, {a: '1'});
		conn.pend_read_fcgi_stdin(1, 'Body 1');
		// accept
		let promise = server.accept();
		server.close();
		let error;
		try
		{	await promise;
		}
		catch (e)
		{	error = e;
		}
		assertEquals(error?.message, 'Server shut down');
		// check
		assertEquals(server.nRequests(), 0);
		assertEquals(server.nConnections(), 0);
	}
);

Deno.test
(	'Write body when terminated',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(2, 'responder', false);
			conn.pend_read_fcgi_params(2, {});
			conn.pend_read_fcgi_stdin(2, '');
			// accept
			for await (let req of server)
			{	await req.respond();
				let error;
				try
				{	await writeAll(req, new TextEncoder().encode('Test'));
				}
				catch (e)
				{	error = e;
				}
				assert(error instanceof TerminatedError);
				server.removeListeners();
			}
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'Test closeWrite()',
	async () =>
	{	for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(3, 'responder', false);
			conn.pend_read_fcgi_params(3, {a: '1'});
			conn.pend_read_fcgi_stdin(3, 'Hello');
			// accept
			for await (let req of server)
			{	req.closeWrite();
				assertEquals(map_to_obj(req.params), {a: '1'});
				assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Hello');
				let error;
				try
				{	await req.respond();
				}
				catch (e)
				{	error = e;
				}
				assertEquals(error?.message, 'Connection closed for write');
				server.removeListeners();
			}
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'Protocol error',
	async () =>
	{	let conn_1 = new MockFcgiConn(999, 0, 'no');
		let conn_2 = new MockFcgiConn(999, 0, 'no');
		let listener = new MockListener([conn_1, conn_2]);
		let server = new Server(listener);
		let server_error: Error | undefined;
		server.onError(e => {server_error = e});
		// write request 1 (protocol error)
		conn_1.pend_read_fcgi_begin_request(1, 'responder', true);
		conn_1.currupt_last_bytes(1);
		// write request 2
		conn_2.pend_read_fcgi_begin_request(1, 'responder', true);
		conn_2.pend_read_fcgi_params(1, {id: 'req 2'});
		conn_2.pend_read_fcgi_stdin(1, 'Body 2');
		// accept
		for await (let req of server)
		{	assert(server_error instanceof ProtocolError);
			server_error = undefined;
			assertEquals(map_to_obj(req.params), {id: 'req 2'});
			assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body 2');
			await req.respond({body: 'Hello'});
			server.removeListeners();
		}
		// read
		assertEquals(conn_2.take_written_fcgi_stdout(1), 'status: 200\r\n\r\nHello');
		assertEquals(conn_2.take_written_fcgi_end_request(1), 'request_complete');
		assertEquals(conn_2.take_written_fcgi(), undefined);
		// check
		assert(!server_error);
		assertEquals(server.nConnections(), 0);
		assertEquals(server.nRequests(), 0);
	}
);

Deno.test
(	'Protocol error + onerror throws Error',
	async () =>
	{	let conn_1 = new MockFcgiConn(999, 0, 'no');
		let conn_2 = new MockFcgiConn(999, 0, 'no');
		let listener = new MockListener([conn_1, conn_2]);
		let server = new Server(listener);
		let server_error: Error | undefined;
		server.onError(e => {server_error = e});
		// write request 1 (protocol error)
		conn_1.pend_read_fcgi_begin_request(1, 'responder', true);
		conn_1.currupt_last_bytes(1);
		// write request 2
		conn_2.pend_read_fcgi_begin_request(1, 'responder', true);
		conn_2.pend_read_fcgi_params(1, {id: 'req 2'});
		conn_2.pend_read_fcgi_stdin(1, 'Body 2');
		// accept
		for await (let req of server)
		{	assertEquals(map_to_obj(req.params), {id: 'req 2'});
			assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body 2');
			await req.respond({body: 'Hello'});
			server.removeListeners();
		}
		// read
		assertEquals(conn_2.take_written_fcgi_stdout(1), 'status: 200\r\n\r\nHello');
		assertEquals(conn_2.take_written_fcgi_end_request(1), 'request_complete');
		assertEquals(conn_2.take_written_fcgi(), undefined);
		// check
		assertEquals(server.nConnections(), 0);
		assertEquals(server.nRequests(), 0);
		assert(server_error);
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
				server.onError(e => {console.error(e); server_error = e});
				// write
				conn.pend_read_fcgi_begin_request(1, 'responder', true);
				conn.pend_read_fcgi_params(1, {[str_ok]: 'ok', [str_err]: 'err'});
				conn.pend_read_fcgi_stdin(1, '');
				// accept
				for await (let req of server)
				{	assertEquals(req.params.size, 1);
					assertEquals(req.params.get(str_ok), 'ok');
					assertEquals((await readAll(req.body)).length, 0);
					await req.respond();
					server.removeListeners();
				}
				// read
				assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n');
				assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
				assertEquals(conn.take_written_fcgi(), undefined);
				// check
				assert(!server_error);
				assertEquals(server.nConnections(), 0);
				assertEquals(server.nRequests(), 0);
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
				server.onError(e => {console.error(e); server_error = e});
				// write
				conn.pend_read_fcgi_begin_request(1, 'responder', true);
				conn.pend_read_fcgi_params(1, {'ok': str_ok, 'err': str_err});
				conn.pend_read_fcgi_stdin(1, '');
				// accept
				for await (let req of server)
				{	assertEquals(req.params.size, 1);
					assertEquals(req.params.get('ok'), str_ok);
					assertEquals((await readAll(req.body)).length, 0);
					await req.respond();
					server.removeListeners();
				}
				// read
				assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n');
				assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
				assertEquals(conn.take_written_fcgi(), undefined);
				// check
				assert(!server_error);
				assertEquals(server.nConnections(), 0);
				assertEquals(server.nRequests(), 0);
			}
		}
	}
);

Deno.test
(	'Long body',
	async () =>
	{	for (let len of [1, 2, 3, 8*1024, 8*1024+1, 0xFFF8, 0xFFFF])
		{	for (let conn of test_connections([2, 12, 13]))
			{	let str_request = get_random_bytes(len);
				let str_response = get_random_string(len);
				let listener = new MockListener([conn]);
				let server = new Server(listener);
				let server_error;
				server.onError(e => {console.error(e); server_error = e});
				// write
				conn.pend_read_fcgi_begin_request(1, 'responder', true);
				conn.pend_read_fcgi_params(1, {});
				conn.pend_read_fcgi_stdin(1, new TextDecoder().decode(str_request));
				// accept
				for await (let req of server)
				{	assertEquals((await readAll(req.body)), str_request);
					if (len==1 || len==0xFFF8)
					{	req.logError('Hello');
					}
					await req.respond({body: str_response});
					server.removeListeners();
				}
				// read
				if (len==1 || len==0xFFF8)
				{	assertEquals(conn.take_written_fcgi_stderr(1), 'Hello'); // not terminated STDERR
				}
				assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n'+str_response);
				if (len==1 || len==0xFFF8)
				{	assertEquals(conn.take_written_fcgi_stderr(1), ''); // STDERR terminator record
				}
				assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
				assertEquals(conn.take_written_fcgi(), undefined);
				// check
				assert(!server_error);
				assertEquals(server.nConnections(), 0);
				assertEquals(server.nRequests(), 0);
			}
		}
	}
);

Deno.test
(	'Long body write',
	async () =>
	{	let len = 8*1024+1;
		for (let padding of [-1, 1])
		{	let conn = new MockFcgiConn(999, padding, 'no');
			let str_response = get_random_string(len);
			let listener = new MockListener([conn]);
			let server = new Server(listener);
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', true);
			conn.pend_read_fcgi_params(1, {});
			conn.pend_read_fcgi_stdin(1, '');
			// accept
			for await (let req of server)
			{	writeAll(req, new TextEncoder().encode(str_response));
				await req.respond();
				server.removeListeners();
			}
			// read
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n'+str_response);
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
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
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(2, 'responder', false);
			conn.pend_read_fcgi_params(2, {});
			conn.pend_read_fcgi_stdin(2, '');
			// accept
			for await (let req of server)
			{	assertEquals(req.params.size, 0);
				req.logError('Hello');
				await req.respond();
				server.removeListeners();
			}
			// read
			assertEquals(conn.take_written_fcgi_stderr(2), 'Hello'); // not terminated STDERR
			assertEquals(conn.take_written_fcgi_stdout(2), 'status: 200\r\n\r\n');
			assertEquals(conn.take_written_fcgi_stderr(2), ''); // STDERR terminator record
			assertEquals(conn.take_written_fcgi_end_request(2), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'Get values',
	async () =>
	{	const maxConns = 10;
		for (let conn of test_connections())
		{	let listener = new MockListener([conn]);
			let server = new Server(listener, {maxConns});
			let server_error;
			server.onError(e => {console.error(e); server_error = e});
			// write
			conn.pend_read_fcgi_begin_request(1, 'responder', false);
			conn.pend_read_fcgi_get_values({FCGI_MAX_CONNS: '', FCGI_MAX_REQS: '', FCGI_MPXS_CONNS: '', HELLO: ''});
			conn.pend_read_fcgi_params(1, {a: '1'});
			conn.pend_read_fcgi_stdin(1, 'Body');
			// accept
			for await (let req of server)
			{	assertEquals(map_to_obj(req.params), {a: '1'});
				await req.respond();
				server.removeListeners();
			}
			// read
			assertEquals(map_to_obj(await conn.take_written_fcgi_get_values_result()), {FCGI_MAX_CONNS: maxConns+'', FCGI_MAX_REQS: maxConns+'', FCGI_MPXS_CONNS: '0'});
			assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n');
			assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
			assertEquals(conn.take_written_fcgi(), undefined);
			// check
			assert(!server_error);
			assertEquals(server.nConnections(), 0);
			assertEquals(server.nRequests(), 0);
		}
	}
);

Deno.test
(	'Roles',
	async () =>
	{	let conn = new MockFcgiConn(999, 0, 'no');
		let listener = new MockListener([conn]);
		let server = new Server(listener);
		// write
		conn.pend_read_fcgi_begin_request(1, 'authorizer', true);
		conn.pend_read_fcgi_params(1, {a: '1'});
		conn.pend_read_fcgi_stdin(1, 'Body 1');
		conn.pend_read_fcgi_begin_request(2, 'responder', true);
		conn.pend_read_fcgi_params(2, {a: '2'});
		conn.pend_read_fcgi_stdin(2, 'Body 2');
		// accept
		for await (let req of server)
		{	assertEquals(map_to_obj(req.params), {a: '2'});
			assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body 2');
			await req.respond();
			server.removeListeners();
		}
		// read
		assertEquals(conn.take_written_fcgi_end_request(1), 'unknown_role');
		assertEquals(conn.take_written_fcgi_stdout(2), 'status: 200\r\n\r\n');
		assertEquals(conn.take_written_fcgi_end_request(2), 'request_complete');
		assertEquals(conn.take_written_fcgi(), undefined);
		// check
		assertEquals(server.nConnections(), 0);
		assertEquals(server.nRequests(), 0);
	}
);

Deno.test
(	'Try mux, abort unexisting and unknown type',
	async () =>
	{	let conn = new MockFcgiConn(999, 0, 'no');
		let listener = new MockListener([conn]);
		let server = new Server(listener);
		// write
		conn.pend_read_fcgi_begin_request(1, 'responder', true);
		conn.pend_read_fcgi_begin_request(2, 'responder', true);
		conn.pend_read_fcgi_abort_request(3);
		conn.pend_read_fcgi(100, 4, '***');
		conn.pend_read_fcgi_params(1, {a: '1'});
		conn.pend_read_fcgi_stdin(1, 'Body 1');
		// accept
		for await (let req of server)
		{	assertEquals(map_to_obj(req.params), {a: '1'});
			assertEquals(new TextDecoder().decode(await readAll(req.body)), 'Body 1');
			await req.respond();
			server.removeListeners();
		}
		// read
		assertEquals(conn.take_written_fcgi_end_request(2), 'cant_mpx_conn');
		assertEquals(conn.take_written_fcgi_end_request(3), 'request_complete');
		assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\n');
		assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
		assertEquals(conn.take_written_fcgi_unknown_type(), '100');
		assertEquals(conn.take_written_fcgi(), undefined);
		// check
		assertEquals(server.nConnections(), 0);
		assertEquals(server.nRequests(), 0);
	}
);

Deno.test
(	'Simultaneous connections + Multiple listeners',
	async () =>
	{	const n_listeners = 15;
		const maxConns = 10;
		const multiplier = 10;
		const multiplier_2 = 2;
		assert(maxConns*multiplier*multiplier_2 < 0xFFFF); // request id is 16-bit unsigned, starts from 1 (0 is reserved)
		let listeners: {listener: MockListener, conns: MockFcgiConn[]}[] = [{listener: new MockListener, conns: []}];
		let server = new Server(listeners[0].listener, {maxConns});
		// write
		for (let l=0; l<n_listeners; l++)
		{	if (!listeners[l])
			{	listeners[l] = {listener: new MockListener, conns: []};
				server.addListener(listeners[l].listener);
			}
			let {listener, conns} = listeners[l];
			for (let i=0; i<maxConns*multiplier; i++)
			{	let conn = listener.pend_accept(1024, -1, 'full');
				conns[i] = conn;
				for (let j=0; j<multiplier_2; j++)
				{	let req_id = 1 + j*maxConns*multiplier + i;
					conn.pend_read_fcgi_begin_request(req_id, 'responder', true);
					conn.pend_read_fcgi_params(req_id, {l: l+'', id: `req ${req_id}`});
					conn.pend_read_fcgi_stdin(req_id, `Body ${l}.${req_id}`);
				}
			}
		}
		// try adding the same listener
		assert(!server.addListener(listeners[0].listener));
		// accept
		let i = 0;
		for await (let req of server)
		{	readAll(req.body).then
			(	async body =>
				{	assertEquals(req.params.size, 2);
					let l = req.params.get('l');
					let req_id = req.params.get('id');
					assertEquals(req_id?.slice(0, 4), 'req ');
					req_id = req_id!.slice(4);
					assertEquals(new TextDecoder().decode(body), `Body ${l}.${req_id}`);
					await sleep(0);
					await req.respond({body: `Response ${l}.${req_id}`});
					assert(server.nConnections() <= Math.max(maxConns, n_listeners));
					assert(server.nRequests() <= Math.max(maxConns, n_listeners));
				}
			);
			if (++i == n_listeners*maxConns*multiplier*multiplier_2)
			{	server.removeListeners();
				// try removing inexistant listener
				assert(!server.removeListener(listeners[0].listener.addr));
			}
		}
		// read
		for (let l=0; l<n_listeners; l++)
		{	for (let i=0; i<maxConns*multiplier; i++)
			{	let conn = listeners[l].conns[i];
				for (let j=0; j<multiplier_2; j++)
				{	let req_id = 1 + j*maxConns*multiplier + i;
					assertEquals(conn.take_written_fcgi_stdout(req_id), `status: 200\r\n\r\nResponse ${l}.${req_id}`);
					assertEquals(conn.take_written_fcgi_end_request(req_id), 'request_complete');
				}
				assertEquals(conn.take_written_fcgi(), undefined);
			}
		}
		// check
		assertEquals(server.nConnections(), 0);
		assertEquals(server.nRequests(), 0);
	}
);
