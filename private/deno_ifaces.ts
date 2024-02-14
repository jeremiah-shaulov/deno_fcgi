/**	Interface definitions from `Deno.*`, like `Deno.Conn` can change in future versions of deno.
	If i'll implement one such interface explicitly, like `class C implements Deno.Conn {...}` this code can stop working.
	The same can happen if i'll require a function parameter to implement one of the `Deno.*` interfaces.

	In this file i'll define my own versions of the `Deno.*` interfaces of interest.
	I'll try to update this file to keep them compatible.
 **/

interface Reader
{	/** Reads up to `p.byteLength` bytes into `p`. It resolves to the number of
	 * bytes read (`0` < `n` <= `p.byteLength`) and rejects if any error
	 * encountered. Even if `read()` resolves to `n` < `p.byteLength`, it may
	 * use all of `p` as scratch space during the call. If some data is
	 * available but not `p.byteLength` bytes, `read()` conventionally resolves
	 * to what is available instead of waiting for more.
	 *
	 * When `read()` encounters end-of-file condition, it resolves to EOF
	 * (`null`).
	 *
	 * When `read()` encounters an error, it rejects with an error.
	 *
	 * Callers should always process the `n` > `0` bytes returned before
	 * considering the EOF (`null`). Doing so correctly handles I/O errors that
	 * happen after reading some bytes and also both of the allowed EOF
	 * behaviors.
	 *
	 * Implementations should not retain a reference to `p`.
	 *
	 * Use
	 * [`itereateReader`](https://deno.land/std/streams/iterate_reader.ts?s=iterateReader)
	 * from
	 * [`std/streams/iterate_reader.ts`](https://deno.land/std/streams/iterate_reader.ts)
	 * to turn a `Reader` into an {@linkcode AsyncIterator}.
	 */
	read(p: Uint8Array): Promise<number | null>;
}

interface Writer
{	/** Writes `p.byteLength` bytes from `p` to the underlying data stream. It
	 * resolves to the number of bytes written from `p` (`0` <= `n` <=
	 * `p.byteLength`) or reject with the error encountered that caused the
	 * write to stop early. `write()` must reject with a non-null error if
	 * would resolve to `n` < `p.byteLength`. `write()` must not modify the
	 * slice data, even temporarily.
	 *
	 * This function is one of the lowest
	 * level APIs and most users should not work with this directly, but rather use
	 * [`writeAll()`](https://deno.land/std/streams/write_all.ts?s=writeAll) from
	 * [`std/streams/write_all.ts`](https://deno.land/std/streams/write_all.ts)
	 * instead.
	 *
	 * Implementations should not retain a reference to `p`.
	 */
	write(p: Uint8Array): Promise<number>;
}

interface Closer
{	/** Closes the resource, "freeing" the backing file/resource. */
	close(): void;
}

/**	This interface matches `Deno.Conn`, but will not change in future versions of deno.
 	If `Deno.Conn` will change i'll update this interface, and correct the corresponding code in this library.
 **/
export interface Conn extends Reader, Writer, Closer, Disposable
{	/** The local address of the connection. */
	readonly localAddr: Deno.Addr;
	/** The remote address of the connection. */
	readonly remoteAddr: Deno.Addr;
	/**
	 * The resource ID of the connection.
	 *
	 * @deprecated This will be removed in Deno 2.0. See the
	 * {@link https://docs.deno.com/runtime/manual/advanced/migrate_deprecations | Deno 1.x to 2.x Migration Guide}
	 * for migration instructions.
	 */
	readonly rid: number;
	/** Shuts down (`shutdown(2)`) the write side of the connection. Most
	 * callers should just use `close()`. */
	closeWrite(): Promise<void>;

	/** Make the connection block the event loop from finishing.
	 *
	 * Note: the connection blocks the event loop from finishing by default.
	 * This method is only meaningful after `.unref()` is called.
	 */
	ref(): void;
	/** Make the connection not block the event loop from finishing. */
	unref(): void;

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
