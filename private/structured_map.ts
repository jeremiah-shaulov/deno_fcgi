export type PathNode = string | Map<string, PathNode>;

/**	Extends `Map` and provides `setStructured()` method.
 **/
export class StructuredMap extends Map<string, PathNode>
{	constructor(public structuredParams=true)
	{	super();
	}

	/**	If key is like "items[]=a&items[]=b" or "items[a][b]=c", follows the path, creating additional `Map<string, PathNode>` objects.
		The algorithm is similar to how PHP parses GET parameters.
	 **/
	setStructured(name: string, value: string): boolean
	{	let pos = !this.structuredParams ? -1 : name.indexOf('[');
		if (pos == -1)
		{	this.set(name, value);
			return true;
		}
		// deno-lint-ignore no-this-alias
		let map: Map<string, PathNode> = this;
		let sub = name.slice(0, pos);
		let ok = true;
		while (true)
		{	let pos_2 = name.indexOf(']', ++pos);
			if (pos_2 == -1)
			{	ok = false;
				break;
			}
			let next_map = map.get(sub);
			if (typeof(next_map) != 'object')
			{	next_map = new Map<string, PathNode>();
				map.set(sub, next_map);
			}
			map = next_map;
			if (pos == pos_2)
			{	sub = map.size+'';
			}
			else
			{	sub = name.slice(pos, pos_2);
			}
			if (name.charAt(++pos_2) != '[')
			{	break;
			}
			pos = pos_2;
		}
		map.set(sub, value);
		return ok;
	}
}
