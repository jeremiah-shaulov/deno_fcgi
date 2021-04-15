export class EventPromises<T>
{	private events: EventPromise<T>[] = [];

	add(callback?: (arg: T) => unknown)
	{	let resolve, reject;
		let promise = new Promise<void>((y, n) => {resolve=y; reject=n});
		this.events.push(new EventPromise(callback, resolve, reject));
		return promise;
	}

	trigger(arg: T)
	{	for (let i=0, i_end=this.events.length; i<i_end; i++)
		{	let event = this.events[i];
			let {callback, resolve, reject} = event;
			event.resolve = undefined;
			event.reject = undefined;
			if (!callback)
			{	resolve?.();
			}
			else
			{	try
				{	let result = callback(arg);
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
					reject?.(e);
				}
			}
		}
	}

	clear()
	{	this.events.length = 0;
	}
}

class EventPromise<T>
{	constructor
	(	public callback: ((arg: T) => unknown) | undefined,
		public resolve: (() => void) | undefined,
		public reject: ((error: Error) => void) | undefined
	){}
}
