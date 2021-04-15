import {ServerRequest} from './mod.ts';
import {pathToRegexp} from "https://deno.land/x/path_to_regexp@v6.2.0/index.ts";

export type Callback = (request: ServerRequest, params: any) => Promise<unknown>;
export type PathPattern = string | string[] | RegExp;
type Route = {addr_str: string, regexp: RegExp | undefined, param_names: string[], callback: Callback};

export class Routes extends Map<string, Map<string, Route[]>>
{	add_route(addr_str: string, path_pattern: PathPattern, callback: Callback)
	{	let prefix = '';
		let suffix = '';
		let regexp: RegExp | undefined;
		let param_names: string[] = [];
		if (path_pattern)
		{	let params: {name: string}[] = [];
			regexp = pathToRegexp(path_pattern, params as any);
			param_names = params.map(v => v.name);
			let {source} = regexp;
			let re_prefix = source.match(/^(?:[^\\\[\](){}<>^$|?+*]|\\[\S\s])*/)![0];
			let re_suffix = source.slice(re_prefix.length).match(/(?:[^\\\[\](){}<>^$|?+*]|\\[\S\s])*$/)![0];
			source = source.slice(re_prefix.length, source.length-re_suffix.length);
			regexp = source ? new RegExp(source, regexp.flags) : undefined;
			prefix = re_prefix.replace(/\\[\S\s]/g, m => m.charAt(1));
			suffix = re_suffix.replace(/\\[\S\s]/g, m => m.charAt(1));
		}
		// add
		let level_1 = this.get(prefix);
		if (level_1 == undefined)
		{	level_1 = new Map<string, Route[]>();
			this.set(prefix, level_1);
		}
		let level_2 = level_1.get(suffix);
		if (level_2 == undefined)
		{	level_2 = [];
			level_1.set(suffix, level_2);
		}
		level_2.push({addr_str, regexp, param_names, callback});
	}

	*get_callback_and_params(addr_str: string, path: string)
	{	for (let [prefix, level_1] of this)
		{	if (path.startsWith(prefix))
			{	for (let [suffix, level_2] of level_1)
				{	if (path.endsWith(suffix))
					{	for (let {addr_str: a, regexp, param_names, callback} of level_2)
						{	if (a == (a.charAt(0)!=':' ? addr_str : addr_str.slice(addr_str.indexOf(':'))))
							{	if (!regexp)
								{	yield {callback, params: {}};
								}
								else
								{	let m = path.match(regexp);
									if (m)
									{	let params: any = {};
										for (let i=0, i_end=param_names.length; i<i_end; i++)
										{	params[param_names[i]] = m[i+1];
										}
										yield {callback, params};
									}
								}
							}
						}
					}
				}
			}
		}
	}

	remove_addr(addr_str: string)
	{	let to_remove_0 = [];
		for (let [prefix, level_1] of this)
		{	let to_remove_1 = [];
			for (let [suffix, level_2] of level_1)
			{	for (let i=level_2.length-1; i>=0; i--)
				{	if (level_2[i].addr_str == addr_str)
					{	level_2.splice(i, 1);
					}
				}
				if (level_2.length == 0)
				{	to_remove_1.push(suffix);
				}
			}
			for (let suffix of to_remove_1)
			{	level_1.delete(suffix);
			}
			if (level_1.size == 0)
			{	to_remove_0.push(prefix);
			}
		}
		for (let prefix of to_remove_0)
		{	this.delete(prefix);
		}
	}
}
