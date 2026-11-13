"""Workspace role policy shared by retrieval and authentication."""

ROLES = {'viewer': 0, 'member': 1, 'admin': 2, 'owner': 3}


def retrieval_filter(scope):
    """Every retrieval must restrict both workspace and minimum document role."""
    workspace, separator, level = str(scope or '').partition('|')
    if not workspace or not separator or not level.isdigit() or int(level) not in ROLES.values():
        raise ValueError('An authenticated workspace retrieval scope is required')
    return {'$and': [{'team_id': workspace}, {'access_level': {'$lte': int(level)}}]}
