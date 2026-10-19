from local_llm.routers.knowledge import KnowledgeFilesResponse
r = KnowledgeFilesResponse(id='k', user_id='u', name='n', description='', created_at=1, updated_at=1,
                           files=[], warnings={'message': 'Some files failed to process', 'errors': ['f1: boom']})
print('warnings field present:', 'warnings' in r.model_dump())
print(r.model_dump_json())
