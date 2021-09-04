export {MockConn} from './mock_conn.ts';
export {MockFcgiConn} from './mock_fcgi_conn.ts';
export {MockListener} from './mock_listener.ts';

export const TEST_CHUNK_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 20, 25, 30, 33, 44, 55, 80, 81, 91, 100, 110, 123, 150, 201, 300, 400, 500, 1000, 10_000, 100_000, 0x7FFF_FFFF];
//export const TEST_CHUNK_SIZES = [8];

export function get_random_bytes(length: number)
{	let buffer = new Uint8Array(length);
	for (let i=0; i<buffer.length; i++)
	{	buffer[i] = 32 + Math.floor(Math.random()*90);
	}
	return buffer;
}

export function get_random_string(length: number)
{	return new TextDecoder().decode(get_random_bytes(length));
}

export function map_to_obj(map: any)
{	let j = JSON.stringify
	(	map,
		(k, v) =>
		{	if (v instanceof Map || v instanceof Headers)
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
