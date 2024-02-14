import {StructuredMap, PathNode} from "./structured_map.ts";

export class Get extends StructuredMap
{	private is_inited = false;

	constructor
	(	private query_string='',
		/// Parse params like "items[]=a&items[]=b" and "items[a][b]=c" to Map objects, like PHP does.
		public structuredParams = false,
	)
	{	super(structuredParams);
	}

	setQueryString(query_string: string)
	{	this.query_string = query_string;
		this.is_inited = false;
		super.clear();
	}

	get size()
	{	this.init();
		return super.size;
	}

	clear()
	{	this.setQueryString('');
	}

	private init()
	{	if (!this.is_inited)
		{	this.is_inited = true;
			const {query_string} = this;
			this.query_string = ''; // free memory
			let i = 0;
			while (i < query_string.length)
			{	let i_end = query_string.indexOf('&', i);
				if (i_end == -1)
				{	i_end = query_string.length;
				}
				const eq = query_string.indexOf('=', i);
				let name;
				let value = '';
				if (eq<i_end && eq!=-1)
				{	name = decodeURIComponent(query_string.slice(i, eq));
					value = decodeURIComponent(query_string.slice(eq+1, i_end));
				}
				else
				{	name = decodeURIComponent(query_string.slice(i, i_end));
				}
				this.setStructured(name, value);
				i = i_end + 1;
			}
		}
	}

	has(name: string)
	{	this.init();
		return super.has(name);
	}

	get(name: string)
	{	this.init();
		return super.get(name);
	}

	set(name: string, value: string)
	{	this.init();
		return super.set(name, value);
	}

	delete(name: string)
	{	this.init();
		return super.delete(name);
	}

	entries()
	{	this.init();
		return super.entries();
	}

	keys()
	{	this.init();
		return super.keys();
	}

	values()
	{	this.init();
		return super.values();
	}

	forEach(callback: (value: PathNode, key: string, map: Map<string, PathNode>) => void, thisArg?: any)
	{	this.init();
		return super.forEach(callback, thisArg);
	}

	[Symbol.iterator]()
	{	this.init();
		return super[Symbol.iterator]();
	}
}
