import {fcgi} from 'https://deno.land/x/fcgi@v2.0.6/mod.ts';

for (let i=0; i<3; i++)
{	queueMicrotask
	(	async () =>
		{	console.log(`Begin ${i}`);
			const resp = await fcgi.fetch
			(	{	addr: 'localhost:9990',
					keepAliveMax: 4, // Set to <= -F argument of the `spawn-fcgi`. Keeping alive will hold the connection busy, and all the requests can be made only through limited number of connections.
					timeout: 10_000,
				},
				'http://localhost.com/'
			);
			const t = await resp.text();
			console.log(`End ${i}: ${t}`);
		}
	);
}
