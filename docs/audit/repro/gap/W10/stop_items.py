import asyncio, sys
from local_llm import tasks as T

async def worker(n):
    try:
        await asyncio.sleep(3600)
    except asyncio.CancelledError:
        print(f'  task {n} cancelled')
        raise

async def main():
    for n in range(1, int(sys.argv[1]) + 1):
        await T.create_task(None, worker(n), id='chat-1', task_id=f't{n}')
    await asyncio.sleep(0.05)
    print('before stop:', T.item_tasks)
    res = await T.stop_item_tasks(None, 'chat-1')
    print('stop_item_tasks ->', res)
    await asyncio.sleep(0.1)
    print('still running:', {k: not t.done() for k, t in T.tasks.items()})
    print('item_tasks now:', T.item_tasks)
    print('has_active_tasks:', await T.has_active_tasks(None, 'chat-1'))

asyncio.run(main())
