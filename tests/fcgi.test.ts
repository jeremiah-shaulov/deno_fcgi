import {fcgi} from "../mod.ts";
import {TEST_CHUNK_SIZES, map_to_obj, MockListener, MockFcgiConn, MockConn} from './mock/mod.ts';
import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";

Deno.test
(	'Basic',
	async () =>
	{	let conn = new MockFcgiConn(1024, -1, false);
		let listener = new MockListener([conn]);
		// write
		conn.pend_read_fcgi_begin_request(1, 'responder', false);
		conn.pend_read_fcgi_params(1, {a: '1'});
		conn.pend_read_fcgi_stdin(1, 'Body');
		// accept
		fcgi.listen
		(	listener,
			async req =>
			{	await req.post.parse();
				await req.respond({body: 'Response body'});
				fcgi.unlisten();
			}
		);
		await new Promise<void>
		(	y =>
			{	fcgi.on
				(	'end',
					() =>
					{	// read
						assertEquals(conn.take_written_fcgi_stdout(1), 'status: 200\r\n\r\nResponse body');
						assertEquals(conn.take_written_fcgi_end_request(1), 'request_complete');
						assertEquals(conn.take_written_fcgi(), undefined);
						y();
					}
				);
			}
		);
	}
);
