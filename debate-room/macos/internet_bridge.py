#!/usr/bin/env python3
"""Send the existing end-to-end TLS stream over Cloudflare's WebSocket tunnel."""
import argparse
import asyncio
import os
import re
from http import HTTPStatus
import signal
from tempfile import TemporaryDirectory

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed


async def bridge(websocket, port):
    reader, writer = await asyncio.open_connection('127.0.0.1', port)

    async def from_network():
        async for message in websocket:
            if not isinstance(message, bytes):
                await websocket.close(1003)
                return
            writer.write(message)
            await writer.drain()

    async def to_network():
        while chunk := await reader.read(65536):
            await websocket.send(chunk)

    tasks = [asyncio.create_task(fn()) for fn in (from_network, to_network)]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        writer.close()
        await writer.wait_closed()


async def run(port, cloudflared, browser_port=None):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    clients = set()

    async def handle(websocket):
        if len(clients) >= 32:
            await websocket.close(1013)
            return
        clients.add(websocket)
        try:
            target = browser_port if websocket.request.path == '/guest' else port
            await bridge(websocket, target)
        except (OSError, ConnectionClosed):
            pass
        finally:
            clients.discard(websocket)

    def health(connection, request):
        if request.path == '/health':
            return connection.respond(HTTPStatus.OK, 'Debate Room tunnel ready')
        if request.path == '/guest' and browser_port:
            if request.headers.get_all('Origin') != ['https://jasonkessler.github.io']:
                return connection.respond(HTTPStatus.FORBIDDEN, 'Open the GitHub Pages guest link')
            return None
        if request.path != '/debate':
            return connection.respond(HTTPStatus.NOT_FOUND, 'Not found')

    async with serve(handle, '127.0.0.1', 0, max_size=65536, close_timeout=1, process_request=health) as server:
        local_port = server.sockets[0].getsockname()[1]
        # Use a clean directory so a user's named-tunnel configuration doesn't override this session.
        with TemporaryDirectory(prefix='debate-tunnel-') as directory:
            env = {**os.environ, 'HOME': directory}
            process = await asyncio.create_subprocess_exec(
                cloudflared, 'tunnel', '--no-autoupdate', '--protocol', 'http2',
                '--url', f'http://127.0.0.1:{local_port}', cwd=directory, env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            )
            async def confirm(hostname):
                for _ in range(20):
                    probe = await asyncio.create_subprocess_exec(
                        '/usr/bin/curl', '-fsS', '--max-time', '4',
                        '--doh-url', 'https://cloudflare-dns.com/dns-query', f'https://{hostname}/health',
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                    )
                    try:
                        output, _ = await probe.communicate()
                    finally:
                        if probe.returncode is None:
                            probe.terminate()
                            await probe.wait()
                    if probe.returncode == 0 and output == b'Debate Room tunnel ready':
                        print(f'INTERNET_READY wss://{hostname}/debate', flush=True)
                        return
                    await asyncio.sleep(2)

            confirmation = None
            async def monitor():
                nonlocal confirmation
                hostname = None
                ready = False
                while line := await process.stdout.readline():
                    text = line.decode(errors='replace')
                    if match := re.search(r'\|\s+https://([a-z0-9-]+\.trycloudflare\.com)\s+\|', text):
                        hostname = match[1]
                    if 'Registered tunnel connection' in text:
                        ready = True
                    if hostname and ready and confirmation is None:
                        confirmation = asyncio.create_task(confirm(hostname))
                    elif 'ERR' in text:
                        print(text.rstrip(), flush=True)
            tasks = [asyncio.create_task(monitor()), asyncio.create_task(stop.wait())]
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                if process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), 3)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
                if confirmation is not None:
                    tasks.append(confirmation)
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('port', type=int)
    parser.add_argument('cloudflared')
    parser.add_argument('--browser-port', type=int)
    args = parser.parse_args()
    asyncio.run(run(args.port, args.cloudflared, args.browser_port))
