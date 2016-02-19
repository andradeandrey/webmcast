import os
import html
import builtins
import importlib


def flatten(xs):
    for x in xs:
        if isinstance(x, list):
            yield from flatten(x)
        else:
            yield str(x)


class Tag:
    VOID = frozenset(['area', 'base', 'br', 'col', 'command', 'embed', 'hr', 'img', 'input',
                      'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

    def __init__(self, name, classlist):
        self._name = name
        self._clsl = classlist

    def __getattr__(self, name):
        return Tag(self._name, self._clsl + [name.replace('_', '-')])

    def __call__(self, *items, **kwargs):
        args = ''.join(' %s' % k.replace('_', '-') if v is None else
                       ' %s="%s"' % (k.replace('_', '-'), v) for k, v in kwargs.items())
        if self._clsl:
            args += ' class="%s"' % ' '.join(self._clsl)
        return '<' + self._name + args + ' />' if self._name in Tag.VOID else \
               '<' + self._name + args + '>' + ''.join(flatten(items)) + '</' + self._name + '>'


def load(name, cache={}):
    try:
        mod, mtime = cache[name]
    except KeyError:
        mod, mtime = importlib.import_module('.' + name, __package__), None
    real_mtime = os.stat(mod.__file__).st_mtime
    if mtime != real_mtime:
        importlib.reload(mod)
        for maybe_tag in mod.render.__code__.co_names:
            if maybe_tag not in mod.__dict__ and maybe_tag not in builtins.__dict__:
                mod.__dict__[maybe_tag] = Tag(maybe_tag, [])
        mod.escape = html.escape
        mod.DOCTYPE = '<!doctype html>'
        cache[name] = mod, real_mtime
    return mod
