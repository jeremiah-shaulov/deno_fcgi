import {Client} from "../client.ts";
import {assert, assertEquals} from "https://deno.land/std@0.87.0/testing/asserts.ts";

Deno.test
(	'Options',
	() =>
	{	let options = {maxConns: 10};
		let client = new Client(options);
		assertEquals(client.options().maxConns, options.maxConns);
	}
);
