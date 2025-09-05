# `class` RdStream `extends` ReadableStream\<Uint8Array>

[Documentation Index](../README.md)

This class extends `ReadableStream<Uint8Array>`, and can be used as it's substitutor.
It has the following differences:

- Source is defined with `Deno.Reader`-compatible object.
- No controllers concept.
- BYOB-agnostic. Data consumer can use BYOB or regular reading mode, and there's no need of handling these situations differently.
- No transferring buffers that you pass to `reader.read(buffer)`, so the buffers remain usable after the call.

## This class has

- static method [from](#-static-override-fromrsource-asynciterabler--iterabler--promiseliker-readablestreamr--rdstream)
- [constructor](#-constructorsource-source)
- 3 properties:
[locked](#-override-get-locked-boolean),
[isClosed](#-get-isclosed-boolean),
[closed](#-get-closed-promiseundefined)
- 13 methods:
[getReader](#-override-getreaderoptions-mode-undefined-readablestreamdefaultreaderuint8arrayarraybufferlike--omitreader-read),
[getReader](#-override-getreaderoptions-mode-byob-readablestreambyobreader--omitreader-read),
[getReaderWhenReady](#-getreaderwhenreadyoptions-mode-undefined-promisereadablestreamdefaultreaderuint8arrayarraybufferlike--omitreader-read),
[getReaderWhenReady](#-getreaderwhenreadyoptions-mode-byob-promisereadablestreambyobreader--omitreader-read),
[cancel](#-override-cancelreason-unknown-promisevoid),
[unread](#-unreadchunk-uint8array-void),
[values](#-override-valuesoptions-preventcancel-boolean-readablestreamiterator),
[tee](#-override-teeoptions-requireparallelread-boolean-rdstream-rdstream),
[pipeTo](#-override-pipetodest-writablestreamuint8array-options-streampipeoptionslocal-promisevoid),
[pipeThrough](#-override-pipethrought-w-extends-writablestreamuint8array-r-extends-readablestreamttransform-readonly-writable-w-readonly-readable-r-options-streampipeoptionslocal-r),
[uint8Array](#-uint8arrayoptions-lengthlimit-number-promiseuint8arrayarraybufferlike),
[text](#-textlabel-string-options-textdecoderoptions--lengthlimit-number-promisestring),
[\[Symbol.asyncIterator\]](#-override-symbolasynciteratoroptions-preventcancel-boolean-readablestreamiterator)
- base class


## Static members

#### ⚙ `static` `override` from\<R>(source: AsyncIterable\<R> | Iterable\<R | PromiseLike\<R>>): ReadableStream\<R> \& RdStream

> Constructs `RdStream` from an iterable of `Uint8Array`.
> Note that `ReadableStream<Uint8Array>` is also iterable of `Uint8Array`, so it can be converted to `RdStream`,
> and the resulting `RdStream` will be a wrapper on it.
> 
> If you have data source that implements both `ReadableStream<Uint8Array>` and `Deno.Reader`, it's more efficient to create wrapper from `Deno.Reader`
> by calling the `RdStream` constructor.
> 
> ```ts
> // Create from `Deno.Reader`. This is preferred.
> const file1 = await Deno.open('/etc/passwd');
> const rdStream1 = new RdStream(file1); // `file1` is `Deno.Reader`
> console.log(await rdStream1.text());
> 
> // Create from `ReadableStream<Uint8Array>`.
> const file2 = await Deno.open('/etc/passwd');
> const rdStream2 = RdStream.from(file2.readable); // `file2.readable` is `ReadableStream<Uint8Array>`
> console.log(await rdStream2.text());
> ```



## Instance members

#### 🔧 `constructor`(source: [Source](../type.Source/README.md))



#### 📄 `override` `get` locked(): `boolean`

> When somebody wants to start reading this stream, he calls `rdStream.getReader()`, and after that call the stream becomes locked.
> Future calls to `rdStream.getReader()` will throw error till the reader is released (`reader.releaseLock()`).
> 
> Other operations that read the stream (like `rdStream.pipeTo()`) also lock it (internally they get reader, and release it later).



#### 📄 `get` isClosed(): `boolean`



#### 📄 `get` closed(): Promise\<`undefined`>



#### ⚙ `override` getReader(options?: \{mode?: `undefined`}): ReadableStreamDefaultReader\<Uint8Array\<ArrayBufferLike>> \& Omit\<Reader, <mark>"read"</mark>>

> Returns object that allows to read data from the stream.
> The stream becomes locked till this reader is released by calling `reader.releaseLock()` or `reader[Symbol.dispose]()`.
> 
> If the stream is already locked, this method throws error.



#### ⚙ `override` getReader(options: \{mode: <mark>"byob"</mark>}): ReadableStreamBYOBReader \& Omit\<Reader, <mark>"read"</mark>>



#### ⚙ getReaderWhenReady(options?: \{mode?: `undefined`}): Promise\<ReadableStreamDefaultReader\<Uint8Array\<ArrayBufferLike>> \& Omit\<Reader, <mark>"read"</mark>>>

> Like `rdStream.getReader()`, but waits for the stream to become unlocked before returning the reader (and so locking it again).



#### ⚙ getReaderWhenReady(options: \{mode: <mark>"byob"</mark>}): Promise\<ReadableStreamBYOBReader \& Omit\<Reader, <mark>"read"</mark>>>



#### ⚙ `override` cancel(reason?: `unknown`): Promise\<`void`>

> Interrupt current reading operation (reject the promise that `reader.read()` returned, if any),
> and tell to discard further data in the stream.
> This leads to calling `source.cancel(reason)`, even if current `source.read()` didn't finish.
> `source.cancel()` must implement the actual behavior on how to discard further data,
> and finalize the source, as no more callbacks will be called.
> 
> In contrast to `ReadableStream.cancel()`, this method works even if the stream is locked.



#### ⚙ unread(chunk: Uint8Array): `void`

> Push chunk to the stream, so next read will get it.
> This creates internal buffer, and copies the chunk contents to it.



#### ⚙ `override` values(options?: \{preventCancel?: `boolean`}): [ReadableStreamIterator](../private.class.ReadableStreamIterator/README.md)

> This function is the same as `this[Symbol.asyncIterator]`.
> It allows to iterate this stream yielding `Uint8Array` data chunks.
> 
> Usually you want to use `for await...of` to iterate.
> ```ts
> for await (const chunk of rdStream.values())
> {	// ...
> }
> ```
> It's also possible to iterate manually. In this case you need to be "using" the iterator, or to call `releaseLock()` explicitly.
> ```ts
> using it = rdStream.values();
> while (true)
> {	const {value, done} = await it.next();
> 	if (done)
> 	{	break;
> 	}
> 	// ...
> }
> ```
> 
> If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.



#### ⚙ `override` tee(options?: \{requireParallelRead?: `boolean`}): \[[RdStream](../class.RdStream/README.md), [RdStream](../class.RdStream/README.md)]

> Splits the stream to 2, so the rest of the data can be read from both of the resulting streams.
> 
> If you'll read from one stream faster than from another, or will not read at all from one of them,
> the default behavior is to buffer the data.
> 
> If `requireParallelRead` option is set, the buffering will be disabled,
> and parent stream will suspend after each item, till it's read by both of the child streams.
> In this case if you read and await from the first stream, without previously starting reading from the second,
> this will cause a deadlock situation.
> 
> If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.



#### ⚙ `override` pipeTo(dest: WritableStream\<Uint8Array>, options?: [StreamPipeOptionsLocal](../private.interface.StreamPipeOptionsLocal/README.md)): Promise\<`void`>

> Pipe data from this stream to `dest` writable stream (that can be built-in `WritableStream<Uint8Array>` or `WrStream`).
> 
> If the data is piped to EOF without error, the source readable stream is closed as usual (`close()` callback is called on `Source`),
> and the writable stream will be closed unless `preventClose` option is set.
> 
> If destination closes or enters error state, then `pipeTo()` throws exception.
> But then `pipeTo()` can be called again to continue piping the rest of the stream to another destination (including previously buffered data).
> 
> If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.



#### ⚙ `override` pipeThrough\<T, W `extends` WritableStream\<Uint8Array>, R `extends` ReadableStream\<T>>(transform: \{`readonly` writable: W, `readonly` readable: R}, options?: [StreamPipeOptionsLocal](../private.interface.StreamPipeOptionsLocal/README.md)): R

> Uses `rdStream.pipeTo()` to pipe the data to transformer's writable stream, and returns transformer's readable stream.
> 
> The transformer can be an instance of built-in `TransformStream<Uint8Array, unknown>`, `TrStream`, or any other `writable/readable` pair.
> 
> If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.



#### ⚙ uint8Array(options?: \{lengthLimit?: `number`}): Promise\<Uint8Array\<ArrayBufferLike>>

> Reads the whole stream to memory.
> If `lengthLimit` is specified (and is positive number), and the stream happens to be bigger than this number,
> a `TooBigError` exception is thrown.
> 
> If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.



#### ⚙ text(label?: `string`, options?: TextDecoderOptions \& \{lengthLimit?: `number`}): Promise\<`string`>

> Reads the whole stream to memory, and converts it to string, just as `TextDecoder.decode()` does.
> If `lengthLimit` is specified (and is positive number), and the stream happens to be bigger than this number,
> a `TooBigError` exception is thrown.
> 
> If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.



#### ⚙ `override` \[Symbol.asyncIterator](options?: \{preventCancel?: `boolean`}): [ReadableStreamIterator](../private.class.ReadableStreamIterator/README.md)

> Allows to iterate this stream yielding `Uint8Array` data chunks.
> 
> Usually you want to use `for await...of` to iterate.
> ```ts
> for await (const chunk of rdStream)
> {	// ...
> }
> ```
> It's also possible to iterate manually. In this case you need to be "using" the iterator, or to call `releaseLock()` explicitly.
> ```ts
> using it = rdStream.values();
> while (true)
> {	const {value, done} = await it.next();
> 	if (done)
> 	{	break;
> 	}
> 	// ...
> }
> ```
> 
> If the stream is locked, this method throws error. However you can do `getReaderWhenReady()`, and call identical method on the reader.



