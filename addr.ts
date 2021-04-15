export type FcgiAddr = number | string | Deno.Addr;

const RE_NOT_DEFAULT_ROUTE = /[^0\.:]/;
const RE_IS_NUMBER = /^\s*\d+\s*$/;

export function faddr_to_addr(addr: FcgiAddr): Deno.Addr
{	if (typeof(addr) == 'number')
	{	addr = {transport: 'tcp', hostname: '0.0.0.0', port: addr};
	}
	else if (typeof(addr) == 'string')
	{	if (addr.indexOf('/') != -1)
		{	addr = {transport: 'unix', path: addr};
		}
		else if (RE_IS_NUMBER.test(addr))
		{	addr = {transport: 'tcp', hostname: '0.0.0.0', port: parseInt(addr)};
		}
		else
		{	let pos = addr.lastIndexOf(':');
			if (pos>0 && addr.charAt(pos-1)!=':')
			{	let port = parseInt(addr.slice(pos+1));
				if (addr.charAt(0)=='[' && addr.charAt(pos-1)==']')
				{	// assume: IPv6 address, like [::1]:10000
					var hostname = addr.slice(1, pos-1);
				}
				else
				{	hostname = addr.slice(0, pos);
				}
				addr = {transport: 'tcp', hostname, port};
			}
			else
			{	addr = {transport: 'tcp', hostname: addr, port: 0};
			}
		}
	}
	return addr;
}

export function addr_to_string(addr: Deno.Addr)
{	if (addr.transport == 'tcp')
	{	let {hostname, port} = addr;
		if (is_default_route(hostname))
		{	return ':'+port;
		}
		return (hostname.charAt(0)=='[' || hostname.indexOf(':')==-1 ? hostname+':' : '['+hostname+']:') + port;
	}
	else if (addr.transport == 'unix')
	{	return addr.path;
	}
	throw new Error(`Can use only tcp or unix transport: ${JSON.stringify(addr)}`);
}

export function is_default_route(hostname: string)
{	return !RE_NOT_DEFAULT_ROUTE.test(hostname);
}
