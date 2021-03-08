import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";
import {exists} from "https://deno.land/std/fs/mod.ts";
import {Post} from "../post.ts";

const TEST_CHUNK_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 20, 25, 30, 33, 44, 55, 80, 81, 91, 100, 110, 123, 150, 201, 300, 400, 500, 1000, 10_000, 100_000];
//const TEST_CHUNK_SIZES = [100];

class StringReader
{	private buffer: Uint8Array;
	private pos = 0;

	constructor(private str: string, private chunk_size=10)
	{	this.buffer = new TextEncoder().encode(str);
	}

	async read(buffer: Uint8Array): Promise<number|null>
	{	if (this.pos == this.buffer.length)
		{	return null;
		}
		let chunk_size = Math.min(this.buffer.length-this.pos, buffer.length, this.chunk_size);
		buffer.set(this.buffer.subarray(this.pos, this.pos+chunk_size));
		this.pos += chunk_size;
		return chunk_size;
	}
}

function map_to_obj(map: any)
{	let j = JSON.stringify
	(	map,
		(k, v) =>
		{	if (v instanceof Map)
			{	let obj: any = {};
				for (let [mk, mv] of v)
				{	obj[mk] = mv;
				}
				v = obj;
			}
			return v;
		}
	);
	return JSON.parse(j);
}

Deno.test
(	'Urlencoded',
	async () =>
	{	for (let chunk_size of TEST_CHUNK_SIZES)
		{	let post = new Post(new StringReader('item[]=v0&item[1]=v1&item[]=v2&item[amount]=10', chunk_size), 'application/x-www-form-urlencoded', '', 0, true);
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
		{	let post = new Post(new StringReader('123=v0&1234=v1&12345=v2', chunk_size), 'application/x-www-form-urlencoded', '', 0, true, 3);
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
		{	let post = new Post(new StringReader('item[]=12345&item[]=123&item[]=1234', chunk_size), 'application/x-www-form-urlencoded', '', 0, true, 100, 4);
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
			{	let post = new Post(new StringReader(data, chunk_size), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
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

				let post = new Post(new StringReader(data, chunk_size), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true);
				await post.parse();
				assertEquals(map_to_obj(post), i==0 ? {name: 'Orange'} : {name: 'Orange', weight: '0.3'});
				assertEquals(post.files.size, 1);
				let uploaded_file = post.files.get('main image');
				let tmpName = uploaded_file?.tmpName;
				assert(tmpName);
				assert(await exists(tmpName));
				let f = await Deno.open(tmpName, {read: true});
				let contents = new TextDecoder().decode(await Deno.readAll(f));
				f.close();
				assertEquals(contents, file_contents);
				uploaded_file!.tmpName = '';
				assertEquals(uploaded_file, {error: 0, name: '/tmp/current_file', size: file_contents.length, tmpName: '', type: 'application/octet-stream'});
				await post.close();
				assert(!await exists(tmpName));
			}
		}
	}
);

Deno.test
(	'Form-data long name',
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
			{	let post = new Post(new StringReader(data, chunk_size), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 4);
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
(	'Form-data long value',
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
			{	let post = new Post(new StringReader(data, chunk_size), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 2);
				await post.parse();
				assertEquals(map_to_obj(post), {});
				assertEquals(post.files.size, 0);

				// now test with boundary at end
				data += '------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n';
			}
		}

		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new StringReader(data, chunk_size), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 3);
				await post.parse();
				assertEquals(map_to_obj(post), {weight: '0.3'});
				assertEquals(post.files.size, 0);

				// now test with boundary at end
				data += '------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n';
			}
		}

		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new StringReader(data, chunk_size), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 5);
				await post.parse();
				assertEquals(map_to_obj(post), {weight: '0.3'});
				assertEquals(post.files.size, 0);

				// now test with boundary at end
				data += '------WebKitFormBoundaryAmvtsvCs9WGC03jH--\r\n';
			}
		}

		for (let chunk_size of TEST_CHUNK_SIZES)
		{	for (let i=0; i<2; i++)
			{	let post = new Post(new StringReader(data, chunk_size), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 6);
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
(	'Form-data long file',
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
			{	let post = new Post(new StringReader(data, chunk_size), 'multipart/form-data', '----WebKitFormBoundaryAmvtsvCs9WGC03jH', data.length, true, 100, 100, i==0 ? file_contents.length-1 : file_contents.length);
				await post.parse();
				assertEquals(map_to_obj(post), {name: 'Orange'});
				assertEquals(post.files.size, 1);
				let uploaded_file = post.files.get('main image');
				let tmpName = uploaded_file?.tmpName;
				assert(i==0 ? !tmpName : tmpName);
				if (tmpName)
				{	assert(await exists(tmpName));
					let f = await Deno.open(tmpName, {read: true});
					let contents = new TextDecoder().decode(await Deno.readAll(f));
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
