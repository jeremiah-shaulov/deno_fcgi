# `interface` Reader

[Documentation Index](../README.md)

Interface definitions from `Deno.*`, like `Deno.Conn` can change in future versions of deno.
If i'll implement one such interface explicitly, like `class C implements Deno.Conn {...}` this code can stop working.
The same can happen if i'll require a function parameter to implement one of the `Deno.*` interfaces.

In this file i'll define my own versions of the `Deno.*` interfaces of interest.
I'll try to update this file to keep them compatible.

## This interface has

- method [read](#-readp-uint8array-promisenumber)


#### ⚙ read(p: Uint8Array): Promise\<`number`>

> Reads up to `p.byteLength` bytes into `p`. It resolves to the number of
> bytes read (`0` < `n` <= `p.byteLength`) and rejects if any error
> encountered. Even if `read()` resolves to `n` < `p.byteLength`, it may
> use all of `p` as scratch space during the call. If some data is
> available but not `p.byteLength` bytes, `read()` conventionally resolves
> to what is available instead of waiting for more.
> 
> When `read()` encounters end-of-file condition, it resolves to EOF
> (`null`).
> 
> When `read()` encounters an error, it rejects with an error.
> 
> Callers should always process the `n` > `0` bytes returned before
> considering the EOF (`null`). Doing so correctly handles I/O errors that
> happen after reading some bytes and also both of the allowed EOF
> behaviors.
> 
> Implementations should not retain a reference to `p`.
> 
> Use
> [`itereateReader`](https://deno.land/std/streams/iterate_reader.ts?s=iterateReader)
> from
> [`std/streams/iterate_reader.ts`](https://deno.land/std/streams/iterate_reader.ts)
> to turn a `Reader` into an `AsyncIterator`.



