/**	Interface definitions from `Deno.*`, like `Deno.Conn` can change in future versions of deno.
	If i'll implement one such interface explicitly, like `class C implements Deno.Conn {...}` this code can stop working.
	The same can happen if i'll require a function parameter to implement one of the `Deno.*` interfaces.

	In this file i'll define my own versions of the `Deno.*` interfaces of interest.
	I'll try to update this file to keep them compatible.
 **/

/**	This interface matches `Deno.Conn`, but will not change in future versions of deno.
 	If `Deno.Conn` will change i'll update this interface, and correct the corresponding code in this library.
 **/
export interface Conn extends Deno.Reader, Deno.Writer, Deno.Closer
{	/** The local address of the connection. */
	readonly localAddr: Deno.Addr;
	/** The remote address of the connection. */
	readonly remoteAddr: Deno.Addr;
	/** The resource ID of the connection. */
	readonly rid: number;
	/** Shuts down (`shutdown(2)`) the write side of the connection. Most callers should just use `close()`. */
	closeWrite(): Promise<void>;

	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
}

/**	This interface matches `Deno.Listener`, but will not change in future versions of deno.
 	If `Deno.Listener` will change i'll update this interface, and correct the corresponding code in this library.
 **/
export interface Listener extends AsyncIterable<Conn>
{	/** Waits for and resolves to the next connection to the `Listener`. */
	accept(): Promise<Conn>;
	/** Close closes the listener. Any pending accept promises will be rejected with errors. */
	close(): void;
	/** Return the address of the `Listener`. */
	readonly addr: Deno.Addr;

	/** Return the rid of the `Listener`. */
	readonly rid: number;

	[Symbol.asyncIterator](): AsyncIterableIterator<Conn>;
}
