"""A model's stop sequences keep their text, and a single string stays one sequence (#271).

The stop mapping turns escape sequences typed in the model's settings (`\\n`
as two characters) into the characters they name. It did so by round-tripping
every stop string through `unicode_escape`, which reads its input as latin-1,
so `。` became `ã\\x80\\x82` and `Résumé:` became `RÃ©sumÃ©:`; and it iterated
over the value, so a string `END` became `['E', 'N', 'D']`. Both the OpenAI
and the Ollama mappings did this.

Run from apps/server:

    python -m pytest tests/test_stop_sequences.py
"""

import pytest

from local_llm.utils.payload import apply_model_params_to_body_ollama, apply_model_params_to_body_openai

CASES = [
    (['。'], ['。']),
    (['Résumé:'], ['Résumé:']),
    (['Ответ:', '🛑'], ['Ответ:', '🛑']),
    ('END', ['END']),
    ('Résumé:', ['Résumé:']),
    # Escapes typed as text still become the characters they name.
    (['\\n', 'a\\tb', '\\u00e9t\\u00e9', '\\x41'], ['\n', 'a\tb', 'été', 'A']),
    (['Fin\\n。'], ['Fin\n。']),
    (['\\\\n'], ['\\n']),
    (['\\N{BULLET} '], ['• ']),
    # A backslash that starts no escape, or one naming no character, is left alone.
    (['C:\\path'], ['C:\\path']),
    (['end\\'], ['end\\']),
    (['\\x4', '\\u00e'], ['\\x4', '\\u00e']),
    (['\\UFFFFFFFF'], ['\\UFFFFFFFF']),
    (['\\N{NOT A CHARACTER NAME}'], ['\\N{NOT A CHARACTER NAME}']),
]


@pytest.mark.parametrize(('stop', 'expected'), CASES)
def test_openai_stop_sequences(stop, expected):
    assert apply_model_params_to_body_openai({'stop': stop}, {})['stop'] == expected


@pytest.mark.parametrize(('stop', 'expected'), CASES)
def test_ollama_stop_sequences(stop, expected):
    assert apply_model_params_to_body_ollama({'stop': stop}, {})['options']['stop'] == expected
