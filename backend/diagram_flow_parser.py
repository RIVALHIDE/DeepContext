"""
Diagram-to-React-Flow parser.

Converts PlantUML and Mermaid diagram code into a structured JSON format
that the frontend React Flow (@xyflow/react) canvas can render directly.

Output schema:
{
  "nodes": [
    {"id": "n1", "type": "default", "data": {"label": "User"}, "position": {"x": 0, "y": 0}},
    ...
  ],
  "edges": [
    {"id": "e1", "source": "n1", "target": "n2", "label": "sends", "type": "smoothstep"},
    ...
  ]
}
"""

import re
import hashlib

# ── Layout helpers ──────────────────────────────────────────────────────────

def _make_id(raw: str) -> str:
    """Generate a stable, short, alphanumeric node ID from a raw label."""
    h = hashlib.md5(raw.encode()).hexdigest()[:8]
    return f"n{h}"


def _auto_layout(nodes: list[dict], layout_type: str = "vertical") -> list[dict]:
    """
    Assign positions to nodes using a simple grid or radial layout.
    Vertical: top-to-bottom columns (good for sequence/flow).
    Horizontal: left-to-right rows (good for flowcharts).
    Radial: circle (good for architecture).
    """
    if not nodes:
        return nodes

    n = len(nodes)
    if layout_type == "horizontal":
        cols = max(1, int(n ** 0.5) + 1)
        for i, node in enumerate(nodes):
            col = i % cols
            row = i // cols
            node["position"] = {"x": col * 200, "y": row * 120}
    elif layout_type == "radial":
        import math
        radius = max(150, n * 30)
        for i, node in enumerate(nodes):
            angle = 2 * math.pi * i / n
            node["position"] = {
                "x": int(radius * math.cos(angle)) + radius,
                "y": int(radius * math.sin(angle)) + radius,
            }
    else:  # vertical
        for i, node in enumerate(nodes):
            node["position"] = {"x": 0, "y": i * 100}

    return nodes


# ── PlantUML parsing ──────────────────────────────────────────────────────────

_PLANTUML_PARTICIPANT = re.compile(
    r'(?:participant|actor|boundary|control|database|entity|collections|queue)\s+"?([^"\s]+)"?\s*(?:as\s+(\w+))?',
    re.IGNORECASE,
)
_PLANTUML_ARROW = re.compile(
    r'(\w+)\s*(?:-[.)>o]+|-->|-->)\s*(?:(\[.*?\]|".*?")\s*)?(\w+)',
    re.IGNORECASE,
)
_PLANTUML_USECASE = re.compile(r'usecase\s+"?([^"]+)"?', re.IGNORECASE)
_PLANTUML_REL = re.compile(
    r'(\w+)\s*(?:-->|--\>|\.>|:>|<\||\|\>|o--|--\*|--\+|--\|)\s*(?:(\[.*?\]|".*?")\s*)?(\w+)',
    re.IGNORECASE,
)
_PLANTUML_CLASS = re.compile(r'(?:class|interface|enum|abstract)\s+(\w+)', re.IGNORECASE)
_PLANTUML_CLASS_REL = re.compile(
    r'(\w+)\s*(?:<\.\.|\.\.>|\*--|\+--|--\||\|--)?\s*(\w+)',
    re.IGNORECASE,
)


def parse_plantuml_to_flow(code: str) -> dict:
    """
    Parse a PlantUML block and return React Flow {nodes, edges}.

    Handles sequence, use-case, class, and component diagrams at a basic level.
    """
    lines = code.strip().splitlines()
    nodes = {}
    edges = []
    seen_edge_ids = set()

    def _ensure_node(label: str) -> str:
        nid = _make_id(label)
        if nid not in nodes:
            nodes[nid] = {
                "id": nid,
                "type": "default",
                "data": {"label": label},
                "position": {"x": 0, "y": 0},
            }
        return nid

    # Detect diagram type from content
    has_participants = bool(_PLANTUML_PARTICIPANT.search(code))
    has_classes = bool(_PLANTUML_CLASS.search(code))
    has_usecases = bool(_PLANTUML_USECASE.search(code))

    # Parse participants/actors
    for line in lines:
        m = _PLANTUML_PARTICIPANT.match(line.strip())
        if m:
            label = m.group(1)
            alias = m.group(2) if m.group(2) else label
            _ensure_node(alias if alias else label)

    # Parse use-case nodes
    for line in lines:
        m = _PLANTUML_USECASE.search(line.strip())
        if m:
            _ensure_node(m.group(1))

    # Parse classes
    for line in lines:
        m = _PLANTUML_CLASS.search(line.strip())
        if m:
            _ensure_node(m.group(1))

    # Parse arrows / relationships
    for line in lines:
        line = line.strip()
        if line.startswith("'") or line.startswith("@") or line.startswith("!"):
            continue
        # Skip participant/actor/class/usecase declarations (already parsed)
        if re.match(r'(participant|actor|class|interface|enum|abstract|usecase|boundary|control|database|entity)\s', line, re.IGNORECASE):
            continue

        m = _PLANTUML_ARROW.search(line)
        if m:
            src_label = m.group(1)
            tgt_label = m.group(3)
            # Extract optional label between
            label_match = re.search(r'\[(.*?)\]|"(.*?)"', line)
            edge_label = label_match.group(1) or label_match.group(2) if label_match else ""

            src_id = _ensure_node(src_label)
            tgt_id = _ensure_node(tgt_label)

            eid = f"e-{src_id}-{tgt_id}-{len(seen_edge_ids)}"
            if eid not in seen_edge_ids:
                seen_edge_ids.add(eid)
                edges.append({
                    "id": eid,
                    "source": src_id,
                    "target": tgt_id,
                    "label": edge_label if edge_label else "",
                    "type": "smoothstep",
                    "animated": False,
                })

    node_list = list(nodes.values())

    # Choose layout
    layout_type = "vertical"
    if has_classes:
        layout_type = "horizontal"
    elif has_usecases and not has_participants:
        layout_type = "radial"

    _auto_layout(node_list, layout_type)

    return {"nodes": node_list, "edges": edges}


# ── Mermaid parsing ───────────────────────────────────────────────────────────

_MERMAID_NODE_DEF = re.compile(
    r'(\w+)(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\}|\(([^)]+)\)|>([^<]+)<)',
)
_MERMAID_EDGE = re.compile(
    r'(\w+)(?:\[([^\]]*)\])?\s*(?:-->|--\>|---\>|==>|-.->|-->|---\>|<-|--|==>|-\.->|===)\s*(?:(\w+)(?:\[([^\]]*)\])?|\|(.+?)\|)?\s*(\w+)',
)
_MERMAID_SIMPLE_EDGE = re.compile(
    r'(\w+)\s*(-->|---\>|==>|-.->|-\.->|<--|-->|-\.-\>|==>\|)\s*(\w+)',
)


def parse_mermaid_to_flow(code: str) -> dict:
    """
    Parse a Mermaid flowchart/graph block and return React Flow {nodes, edges}.
    """
    lines = code.strip().splitlines()
    nodes = {}
    edges = []
    edge_counter = 0

    def _ensure_node(label: str) -> str:
        nid = _make_id(label)
        if nid not in nodes:
            nodes[nid] = {
                "id": nid,
                "type": "default",
                "data": {"label": label},
                "position": {"x": 0, "y": 0},
            }
        return nid

    # Mermaid edge patterns: A --> B, A -->|label| B, A --- B, etc.
    edge_pattern = re.compile(
        r'(\w+)\s*(-->|---\>|-->|==>|-.->|-\.->|<--|===|-\.-\>|---)\s*(?:\|([^|]+)\|)?\s*(\w+)',
    )
    # Node definition patterns: A[label], A(text), A{diamond}, A((circle)), A>asymmetric]
    node_def_pattern = re.compile(
        r'(\w+)\s*(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\}|\(\(([^)]+)\)\)|>([^<]+)<)',
    )
    # Subgraph detection
    subgraph_pattern = re.compile(r'subgraph\s+(.+)', re.IGNORECASE)

    for line in lines:
        line = line.strip()
        if not line or line.startswith("%%") or line.startswith("graph") or line.startswith("flowchart"):
            continue
        if line.startswith("end") or subgraph_pattern.match(line):
            continue

        # Try edge first (A --> B or A -->|label| B)
        edge_match = edge_pattern.search(line)
        if edge_match:
            src_label = edge_match.group(1)
            edge_label = edge_match.group(3) or ""
            tgt_label = edge_match.group(4)
            src_id = _ensure_node(src_label)
            tgt_id = _ensure_node(tgt_label)
            eid = f"e{edge_counter}"
            edge_counter += 1
            edges.append({
                "id": eid,
                "source": src_id,
                "target": tgt_id,
                "label": edge_label,
                "type": "smoothstep",
                "animated": "-->" in line,
            })
            continue

        # Try node definition (A[label])
        node_match = node_def_pattern.search(line)
        if node_match:
            node_id = node_match.group(1)
            # Use the bracket content as label if available, else use the ID
            label = (
                node_match.group(2)
                or node_match.group(3)
                or node_match.group(4)
                or node_match.group(5)
                or node_match.group(6)
                or node_id
            )
            _ensure_node(label)
            continue

        # Bare node reference (just an identifier on its own line)
        bare_match = re.match(r'^(\w+)\s*$', line)
        if bare_match:
            _ensure_node(bare_match.group(1))

    node_list = list(nodes.values())
    _auto_layout(node_list, "horizontal")

    return {"nodes": node_list, "edges": edges}


# ── Main entry point ───────────────────────────────────────────────────────

def diagrams_to_flow(diagrams: list) -> list:
    """
    Take a list of diagram dicts (as produced by diagram_utils.extract_diagrams_from_docs)
    and return a list with an added 'flow' key containing React Flow nodes/edges.

    Each diagram dict looks like:
      {"type": "plantuml"|"mermaid", "code": "...", "title": "...", ...}

    Returns the same list with each dict augmented:
      {..., "flow": {"nodes": [...], "edges": [...]}}
    """
    result = []
    for diagram in diagrams:
        d = dict(diagram)
        code = d.get("code", "")
        dtype = d.get("type", "")

        try:
            if dtype == "plantuml":
                d["flow"] = parse_plantuml_to_flow(code)
            elif dtype == "mermaid":
                d["flow"] = parse_mermaid_to_flow(code)
            else:
                d["flow"] = {"nodes": [], "edges": []}
        except Exception as exc:
            print(f"⚠️ diagram_flow_parser: failed to parse {dtype} diagram: {exc}")
            d["flow"] = {"nodes": [], "edges": []}

        result.append(d)

    return result
