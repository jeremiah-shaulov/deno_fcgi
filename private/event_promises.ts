export class EventPromises<T>
{	private events = new Array<EventPromise<T>>;

	add(callback?: (arg: T) => unknown)
	{	let resolve, reject;
		const promise = new Promise<void>((y, n) => {resolve=y; reject=n});
		this.events.push(new EventPromise(callback, resolve, reject));
		return promise;
	}

	remove(callback: (arg: T) => unknown)
	{	for (let i=0, i_end=this.events.length; i<i_end; i++)
		{	const event = this.events[i];
			if (event.callback == callback)
			{	this.events.splice(i, 1);
				event.resolve?.();
				break;
			}
		}
	}

	trigger(arg: T)
	{	for (let i=0, i_end=this.events.length; i<i_end; i++)
		{	const event = this.events[i];
			const {callback, resolve, reject} = event;
			event.resolve = undefined;
			event.reject = undefined;
			if (!callback)
			{	resolve?.();
				this.events.splice(i--, 1);
				i_end--;
			}
			else
			{	try
				{	const result = callback(arg);
					if (resolve)
					{	if (result instanceof Promise)
						{	result.then(resolve, reject);
						}
						else
						{	resolve();
						}
					}
				}
				catch (e)
				{	console.error(e);
					reject?.(e instanceof Error ? e : new Error(e+''));
				}
			}
		}
	}

	clear()
	{	for (const event of this.events)
		{	event.resolve?.();
		}
		this.events.length = 0;
	}
}

class EventPromise<T>
{	constructor
	(	public callback: ((arg: T) => unknown) | undefined,
		public resolve: (() => void) | undefined,
		public reject: ((error: Error) => void) | undefined
	){}
}
