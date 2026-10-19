from langchain_text_splitters import RecursiveCharacterTextSplitter
for size, overlap in [(0, 0), (100, 200), (1000, 100)]:
    try:
        s = RecursiveCharacterTextSplitter(chunk_size=size, chunk_overlap=overlap, add_start_index=True)
        print(size, overlap, '-> ok', len(s.split_text('hello world ' * 50)))
    except Exception as e:
        print(size, overlap, '->', type(e).__name__, e)
