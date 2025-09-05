# `class` Server `implements` [Listener](../interface.Listener/README.md)

[Documentation Index](../README.md)

```ts
import {Server} from "https://deno.land/x/fcgi@v2.1.2/mod.ts"
```

## This class has

- [constructor](#-constructorlistener-listener-options-serveroptions)
- 2 properties:
[addr](#-readonly-addr-denoaddr),
[rid](#-readonly-rid-number)
- 12 methods:
[options](#-optionsoptions-serveroptions-serveroptions),
[onError](#-onerrorcallback-error-error--unknown-void),
[accept](#-accept-promiseserverrequest),
[nConnections](#-nconnections-number),
[nRequests](#-nrequests-number),
[addListener](#-addlistenerlistener-listener-boolean),
[getListener](#-getlisteneraddr-denoaddr-listener),
[removeListener](#-removelisteneraddr-denoaddr-boolean),
[removeListeners](#-removelisteners-void),
[clear\_removed\_listeners](#-clear_removed_listeners-void),
[close](#-close-void),
[\[Symbol.asyncIterator\]](#-symbolasynciterator-asyncgeneratorserverrequest-any-any)


#### 🔧 `constructor`(listener?: [Listener](../interface.Listener/README.md), options?: [ServerOptions](../interface.ServerOptions/README.md))



#### 📄 `readonly` addr: Deno.Addr

> Return the address of the `Listener`.



#### 📄 `readonly` rid: `number`

> Return the rid of the `Listener`.



#### ⚙ options(options?: [ServerOptions](../interface.ServerOptions/README.md)): [ServerOptions](../interface.ServerOptions/README.md)

> Set and/or get configuration.



#### ⚙ onError(callback?: (error: Error) => `unknown`): `void`

> `onError(callback)` - catch general connection errors. Only one handler is active. Second `onError(callback2)` overrides the previous handler.
> `onError(undefined)` - removes the event handler.



#### ⚙ accept(): Promise\<[ServerRequest](../class.ServerRequest/README.md)>

> Waits for and resolves to the next connection to the `Listener`.



#### ⚙ nConnections(): `number`



#### ⚙ nRequests(): `number`



#### ⚙ addListener(listener: [Listener](../interface.Listener/README.md)): `boolean`



#### ⚙ getListener(addr: Deno.Addr): [Listener](../interface.Listener/README.md)



#### ⚙ removeListener(addr: Deno.Addr): `boolean`



#### ⚙ removeListeners(): `void`



#### ⚙ clear\_removed\_listeners(): `void`



#### ⚙ close(): `void`

> Close closes the listener. Any pending accept promises will be rejected with errors.



#### ⚙ \[Symbol.asyncIterator](): AsyncGenerator\<[ServerRequest](../class.ServerRequest/README.md), `any`, `any`>



