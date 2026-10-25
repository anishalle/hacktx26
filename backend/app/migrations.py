from importlib import import_module


def revisions():
    first = import_module("migrations.versions.001_chat")
    second = import_module("migrations.versions.002_private_answer_search")
    return [
        (first.revision, first.UPGRADE_STATEMENTS),
        (second.revision, second.UPGRADE_STATEMENTS),
    ]
