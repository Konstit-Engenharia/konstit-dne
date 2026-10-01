"""Summarize Chrome CPU profiles inside the profileLookups sampling window.

Usage: python3 bench/summarize-cpu-profile.py profile.cpuprofile [...]
Keep samples without a JS stack (for example GC) between the first and last
profileLookups samples. Group functions across JIT source-position variants.
"""
import json
from pathlib import Path
import sys


def summarize(path):
    profile = json.loads(Path(path).read_text())
    nodes = {node["id"]: node for node in profile["nodes"]}
    parents = {child: node["id"] for node in profile["nodes"] for child in node.get("children", [])}
    samples = profile["samples"]
    deltas = profile["timeDeltas"]
    if len(samples) != len(deltas):
        raise ValueError("Expected one time delta per sample")
    paths = {}
    for node_id in nodes:
        chain = []
        current = node_id
        while current in nodes:
            chain.append(current)
            current = parents.get(current)
        paths[node_id] = chain
    hot_nodes = {node_id for node_id, chain in paths.items()
                 if any(nodes[parent]["callFrame"]["functionName"] == "profileLookups" for parent in chain)}
    hot_samples = [index for index, node_id in enumerate(samples) if node_id in hot_nodes]
    if not hot_samples:
        raise ValueError("No profileLookups frame found; cannot isolate the workload")
    start, end = hot_samples[0], hot_samples[-1] + 1
    total_us = sum(deltas[start:end])
    groups = {}

    def key(node_id):
        frame = nodes[node_id]["callFrame"]
        return (frame["functionName"] or "(anonymous)", frame.get("url", ""))

    def group(identity):
        if identity not in groups:
            groups[identity] = {"function": identity[0], "url": identity[1], "selfSamples": 0, "selfUs": 0, "inclusiveUs": 0}
        return groups[identity]

    for index in range(start, end):
        node_id, elapsed = samples[index], deltas[index]
        current = group(key(node_id))
        current["selfSamples"] += 1
        current["selfUs"] += elapsed
        for identity in {key(parent) for parent in paths[node_id]}:
            group(identity)["inclusiveUs"] += elapsed
    functions = sorted(groups.values(), key=lambda item: item["selfUs"], reverse=True)
    for item in functions:
        item["selfPercent"] = item["selfUs"] / total_us * 100
        item["inclusivePercent"] = item["inclusiveUs"] / total_us * 100
    return {"profile": str(path), "allSamples": len(samples), "workloadSamples": end - start,
            "workloadSampledMs": total_us / 1000, "firstSampleIndex": start, "lastSampleIndex": end - 1,
            "samplesWithoutWorkloadAncestor": sum(node_id not in hot_nodes for node_id in samples[start:end]),
            "functions": functions}


print(json.dumps([summarize(path) for path in sys.argv[1:]], indent=2))
