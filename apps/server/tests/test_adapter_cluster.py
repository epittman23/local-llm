"""An adapter's `[item] cluster_fields` -> the cluster written on each result row.

Run from apps/server:

    python -m pytest tests/test_adapter_cluster.py
"""

from __future__ import annotations

from local_llm.benchmarks.evaluation.adapters import item_cluster, load_adapters


def test_no_cluster_fields_means_independent():
    assert item_cluster({'item': {'id_field': 'task_id'}}, {'task_id': 'x'}) is None


def test_cluster_joins_the_named_fields():
    adapter = {'item': {'cluster_fields': ['metadata.library', 'metadata.perturbation_origin_id']}}
    item = {'metadata': {'library': 'Pandas', 'perturbation_origin_id': 12}}
    assert item_cluster(adapter, item) == 'Pandas/12'


def test_ds1000_clusters_by_original_question_not_library():
    # Clustering by library would leave two clusters in the Pandas/Numpy slice.
    fields = load_adapters()['ds1000']['item']['cluster_fields']
    assert fields == ['metadata.library', 'metadata.perturbation_origin_id']
