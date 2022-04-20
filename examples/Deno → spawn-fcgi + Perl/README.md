## Example of how to use x/fcgi with Perl FastCGI

In order to turn Perl script to a FastCGI service we can use utility called `spawn-fcgi`.
On Ubuntu it can be installed with this command:

```bash
sudo apt install spawn-fcgi
```
This utility starts specified FastCGI script or program in the background. Then it listens on specified socket for FastCGI requests and forwards these requests to the script.

### How to use

1. Start the service. `cd` to the directory where `service.pl` is located, and issue:

```bash
sudo spawn-fcgi -a 127.0.0.1 -p 9990 -F 4 -u $USER -g $USER -- /usr/bin/perl -wT $PWD/service.pl
```

- `-a` and `-p` set the address on which this service will listen. Alternatively you can use `-s` for UNIX-domain socket.
- `-F` specifies number of child processes to spawn. This number of concurrent requests can be handled.
- `-u` and `-g` - the processes will run from this user and group.

2. Make requests to this service:

```bash
deno run --allow-net use_the_service.ts
```

The `use_the_service.ts` script executes `fetch` to the `service.pl` service (`localhost:9990`) 3 times.
