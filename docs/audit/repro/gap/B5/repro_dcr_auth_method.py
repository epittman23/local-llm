"""Repro: token_endpoint_auth_method picks the server's first method even when it is not one we support."""
from mcp.shared.auth import OAuthMetadata
from local_llm.utils.oauth import OAuthClientMetadata, OAuthClientInformationFull

print('validate_assignment:', OAuthClientMetadata.model_config.get('validate_assignment'))

meta = OAuthMetadata.model_validate({
    'issuer': 'https://as.example.com',
    'authorization_endpoint': 'https://as.example.com/authorize',
    'token_endpoint': 'https://as.example.com/token',
    'registration_endpoint': 'https://as.example.com/register',
    'response_types_supported': ['code'],
    'token_endpoint_auth_methods_supported': ['private_key_jwt', 'client_secret_basic'],
})

# --- dynamic path, mirroring oauth.py:541-549
cm = OAuthClientMetadata(client_name='x', redirect_uris=['https://app/cb'], grant_types=['authorization_code','refresh_token'], response_types=['code'])
if meta.token_endpoint_auth_methods_supported and cm.token_endpoint_auth_method not in meta.token_endpoint_auth_methods_supported:
    cm.token_endpoint_auth_method = meta.token_endpoint_auth_methods_supported[0]
print('DCR registers with:', cm.model_dump(mode='json', exclude_none=True).get('token_endpoint_auth_method'))

# a compliant AS echoes the method back in the registration response
try:
    OAuthClientInformationFull.model_validate({'client_id': 'abc', 'redirect_uris': ['https://app/cb'], 'token_endpoint_auth_method': 'private_key_jwt'})
    print('registration response accepted')
except Exception as e:
    print('registration response rejected:', type(e).__name__, str(e).splitlines()[0:3])

# --- static path, mirroring oauth.py:680-699
m = 'client_secret_post'
if meta.token_endpoint_auth_methods_supported and m not in meta.token_endpoint_auth_methods_supported:
    m = meta.token_endpoint_auth_methods_supported[0]
try:
    OAuthClientInformationFull(client_id='abc', client_secret='s', redirect_uris=['https://app/cb'], token_endpoint_auth_method=m)
    print('static accepted with', m)
except Exception as e:
    print('static rejected:', type(e).__name__, str(e).splitlines()[0:3])
