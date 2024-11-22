import {Writer} from './deno_ifaces.ts';

export async function writeAll(writer: Writer, buffer: Uint8Array)
{	while (buffer.length > 0)
	{	const n = await writer.write(buffer);
		buffer = buffer.subarray(n);
	}
}
