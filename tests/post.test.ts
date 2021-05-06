import {Post} from "../post.ts";
import {TEST_CHUNK_SIZES, map_to_obj, MockConn} from './mock/mod.ts';
import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {exists} from "https://deno.land/std/fs/mod.ts";
import {readAll} from 'https://deno.land/std/io/util.ts';

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
(	'Urlencoded',
	async () =>
	{	for (let chunk_size of TEST_CHUNK_SIZES)
		{	let post = new Post(new MockConn('item[]=v0&item[1]=v1&item[]=v2&item[amount]=10', chunk_size), console.error.bind(console), 'application/x-www-form-urlencoded', '', 0, true);
			await post.parse();
			assertEquals(map_to_obj(post), {item: {'0': 'v0', '1': 'v1', '2': 'v2', amount: '10'}});
			assertEquals(post.files.size, 0);
		}
	}
);

Deno.test
(	'Urlencoded long name',
	async () =>
	{	for (let chunk_size of TEST_CHUNK_SIZES)
		{	let post = new Post(new MockConn('123=v0&1234=v1&12345=v2', chunk_size), console.error.bind(console), 'application/x-www-form-urlencoded', '', 0, true, 3);
			await post.parse();
			assertEquals(map_to_obj(post), {'123': 'v0'});
			assertEquals(post.files.size, 0);
		}
	}
);

Deno.test
(	'Urlencoded long value',
	async () =>
	{	for (let chunk_size of TEST_CHUNK_SIZES)
		{	let post = new Post(new MockConn('item[]=12345&item[]=123&item[]=1234', chunk_size), console.error.bind(console), 'application/x-www-form-urlencoded', '', 0, true, 100, 4);
			await post.parse();
			assertEquals(map_to_obj(post), {item: {'0': '123', '1': '1234'}});
			assertEquals(post.files.size, 0);
		}
	}
);

Deno.test
(	'Form-data',
	async () =>
	{	let data =
		(	'IGNORE'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);

		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
				await post.parse();
				assertEquals(map_to_obj(post), {name: 'Orange', weight: '0.3'});
				assertEquals(post.files.size, 0);

				// now test with boundary at end
				data += '------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n';
			}
		}
	}
);

Deno.test
(	'Form-data file',
	async () =>
	{	let weight =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);
		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let file_contents = 'ABC\r\nDEF\nGHI';
				let data =
				(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
					'Content-Disposition: form-data; name="name"\r\n'+
					'\r\n'+
					'Orange\r\n'+
					'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
					'Content-Disposition: form-data; name="main image"; filename="/tmp/current_file"\r\n'+
					'Content-Type: application/octet-stream\r\n'+
					'\r\n'+
					file_contents+'\r\n'+
					(i==0 ? '' : weight)+
					'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'
				);

				let post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
				await post.parse();
				assertEquals(map_to_obj(post), i==0 ? {name: 'Orange'} : {name: 'Orange', weight: '0.3'});
				assertEquals(post.files.size, 1);
				let uploaded_file = post.files.get('main image');
				let tmpName = uploaded_file?.tmpName;
				assert(tmpName);
				assert(await exists(tmpName));
				let f = await Deno.open(tmpName, {read: true});
				let contents = new TextDecoder().decode(await readAll(f));
				f.close();
				assertEquals(contents, file_contents);
				assertEquals(uploaded_file, {error: 0, name: '/tmp/current_file', size: file_contents.length, tmpName: uploaded_file!.tmpName, type: 'application/octet-stream'});
				if (i == 1)
				{	await Deno.remove(tmpName); // delete before closing "post"
					assert(!await exists(tmpName));
				}
				await post.close();
				assert(!await exists(tmpName));
			}
		}
	}
);

Deno.test
(	'Form-data too long name',
	async () =>
	{	let data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);

		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 4);
				await post.parse();
				assertEquals(map_to_obj(post), {name: 'Orange'});
				assertEquals(post.files.size, 0);

				// now test with boundary at end
				data += '------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n';
			}
		}
	}
);

Deno.test
(	'Form-data too long value',
	async () =>
	{	let data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="weight"\r\n'+
			'\r\n'+
			'0.3\r\n'
		);

		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 2);
				await post.parse();
				assertEquals(map_to_obj(post), {});
				assertEquals(post.files.size, 0);

				// now test with boundary at end
				data += '------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n';
			}
		}

		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 3);
				await post.parse();
				assertEquals(map_to_obj(post), {weight: '0.3'});
				assertEquals(post.files.size, 0);

				// now test with boundary at end
				data += '------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n';
			}
		}

		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 5);
				await post.parse();
				assertEquals(map_to_obj(post), {weight: '0.3'});
				assertEquals(post.files.size, 0);

				// now test with boundary at end
				data += '------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n';
			}
		}

		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new MockConn(data, chunk_size), console.error.bind(console), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 6);
				await post.parse();
				assertEquals(map_to_obj(post), {name: 'Orange', weight: '0.3'});
				assertEquals(post.files.size, 0);

				// now test with boundary at end
				data += '------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n';
			}
		}
	}
);

Deno.test
(	'Form-data too long file',
	async () =>
	{	let file_contents = 'ABC\r\nDEF\nGHI';
		let data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="main image"; filename="/tmp/current_file"\r\n'+
			'Content-Type: application/octet-stream\r\n'+
			'\r\n'+
			file_contents+'\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'
		);
		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new MockConn(data, chunk_size), () => {}, 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 100, i==0 ? file_contents.length-1 : file_contents.length);
				await post.parse();
				assertEquals(map_to_obj(post), {name: 'Orange'});
				assertEquals(post.files.size, 1);
				let uploaded_file = post.files.get('main image');
				let tmpName = uploaded_file?.tmpName;
				assert(i==0 ? !tmpName : tmpName);
				if (tmpName)
				{	assert(await exists(tmpName));
					let f = await Deno.open(tmpName, {read: true});
					let contents = new TextDecoder().decode(await readAll(f));
					f.close();
					assertEquals(contents, file_contents);
					uploaded_file!.tmpName = '';
					assertEquals(uploaded_file, {error: 0, name: '/tmp/current_file', size: file_contents.length, tmpName: '', type: 'application/octet-stream'});
				}
				else
				{	assertEquals(uploaded_file, {error: 7, name: '/tmp/current_file', size: file_contents.length, tmpName: '', type: 'application/octet-stream'});
				}
				await post.close();
				assert(!tmpName || !await exists(tmpName));
			}
		}
	}
);

Deno.test
(	'Form-data long file',
	async () =>
	{	let file_contents = [get_random_string(8*1024 - 300), get_random_string(8*1024 - 300), get_random_string(100)];
		let data =
		(	'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="name"\r\n'+
			'\r\n'+
			'Orange\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="file 0"; filename="/tmp/file_0"\r\n'+
			'Content-Type: application/octet-stream\r\n'+
			'\r\n'+
			file_contents[0]+'\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="file 1"; filename="/tmp/file_1"\r\n'+
			'Content-Type: application/octet-stream\r\n'+
			'\r\n'+
			file_contents[1]+'\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH\r\n'+
			'Content-Disposition: form-data; name="field 2"\r\n'+
			'\r\n'+
			file_contents[2]+'\r\n'+
			'------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n'
		);
		let post = new Post(new MockConn(data, 10000), () => {}, 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, file_contents[2].length, Math.max(...file_contents.map(v => v.length)));
		await post.parse();
		assertEquals(map_to_obj(post), {name: 'Orange', 'field 2': file_contents[2]});
		assertEquals(post.files.size, 2);
		let tmp_names = [];
		for (let i=0; i<2; i++)
		{	let uploaded_file = post.files.get('file '+i);
			let tmpName = uploaded_file?.tmpName;
			assert(tmpName);
			tmp_names[i] = tmpName;
			assert(await exists(tmpName));
			let f = await Deno.open(tmpName, {read: true});
			let contents = new TextDecoder().decode(await readAll(f));
			f.close();
			assertEquals(contents, file_contents[i]);
			uploaded_file!.tmpName = '';
			assertEquals(uploaded_file, {error: 0, name: '/tmp/file_'+i, size: file_contents[i].length, tmpName: '', type: 'application/octet-stream'});
		}
		await post.close();
		for (let i=0; i<2; i++)
		{	assert(!await exists(tmp_names[i]));
		}
	}
);

Deno.test
(	'Invalid',
	async () =>
	{	for (let chunk_size of TEST_CHUNK_SIZES)
		{	let post = new Post(new MockConn('a[=1&b[KEY][...=2&c=3', chunk_size), console.error.bind(console), 'application/x-www-form-urlencoded', '', 0, true);
			await post.parse();
			assertEquals(map_to_obj(post), {a: '1', b: {KEY: '2'}, c: '3'});
			assertEquals(post.files.size, 0);
		}
		// no boundary
		let data = 'Hello';
		let post = new Post(new MockConn(data), () => {}, 'multipart/form-data', '', data.length);
		await post.parse();
		assertEquals(post.size, 0);
		// no fields after first boundary
		post = new Post(new MockConn(data), () => {}, 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length);
		await post.parse();
		assertEquals(post.size, 0);
	}
);
