# `class` Cookies `extends` Map\<`string`, `string`>

[Documentation Index](../README.md)

## This class has

- [constructor](#-constructorcookie_header-string)
- 3 properties:
[headers](#-headers-mapstring-string),
[cookie\_header](#-cookie_header-string),
[size](#-override-get-size-number)
- 11 methods:
[setHeader](#-setheadercookie_header-string-void),
[clear](#-override-clear-void),
[has](#-override-hasname-string-boolean),
[get](#-override-getname-string-string),
[set](#-override-setname-string-value-string-options-cookieoptions-this),
[delete](#-override-deletename-string-boolean),
[entries](#-override-entries-mapiteratorstring-string),
[keys](#-override-keys-mapiteratorstring),
[values](#-override-values-mapiteratorstring),
[forEach](#-override-foreachcallback-value-string-key-string-map-mapstring-string--void-thisarg-any-void),
[\[Symbol.iterator\]](#-override-symboliterator-mapiteratorstring-string)
- base class


#### 🔧 `constructor`(cookie\_header: `string`="")



#### 📄 headers: Map\<`string`, `string`>



#### 📄 cookie\_header: `string`



#### 📄 `override` `get` size(): `number`



#### ⚙ setHeader(cookie\_header: `string`): `void`



#### ⚙ `override` clear(): `void`



#### ⚙ `override` has(name: `string`): `boolean`



#### ⚙ `override` get(name: `string`): `string`

> Returns a specified element from the Map object. If the value that is associated to the provided key is an object, then you will get a reference to that object and any change made to that object will effectively modify it inside the Map.



#### ⚙ `override` set(name: `string`, value: `string`, options?: [CookieOptions](../interface.CookieOptions/README.md)): `this`

> Adds a new element with a specified key and value to the Map. If an element with the same key already exists, the element will be updated.



#### ⚙ `override` delete(name: `string`): `boolean`



#### ⚙ `override` entries(): MapIterator\<\[`string`, `string`]>

> Returns an iterable of key, value pairs for every entry in the map.



#### ⚙ `override` keys(): MapIterator\<`string`>

> Returns an iterable of keys in the map



#### ⚙ `override` values(): MapIterator\<`string`>

> Returns an iterable of values in the map



#### ⚙ `override` forEach(callback: (value: `string`, key: `string`, map: Map\<`string`, `string`>) => `void`, thisArg?: [Any](../private.type.Any.3/README.md)): `void`

> Executes a provided function once per each key/value pair in the Map, in insertion order.



#### ⚙ `override` \[Symbol.iterator](): MapIterator\<\[`string`, `string`]>



