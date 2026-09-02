"""bridge.py のスコープ衝突を静的解析で検出する（2026-09-02 P0 の再発防止）。

## なぜ要るか

Build 292 の実走（9/2 10:45:22）で、iRacing 接続と同時に telemetry スレッドが落ちた。

    UnboundLocalError: cannot access local variable '_gate_state'

原因は**変数名の衝突**。`_gate_state` はモジュール変数（発話ゲートの保留状態）だが、
`RACE SUMMARY GATE` の計装が同じ名前を `poll_iracing()` 内で代入したため、
Python が関数内の `_gate_state` を**全てローカル扱い**にし、
先に実行される `_gate_state['pending'] = None` が未代入参照になった。

## なぜ既存の検査を全部通り抜けたか

- `python3 -m py_compile` … 構文のみ。UnboundLocalError は実行時
- preflight 86スイート … `poll_iracing()` を**実行するテストが1つも無い**
- Gate 4 / Gate 5 … artifact 内に文字列 `RACE SUMMARY GATE` が**存在すること**は確認したが、
  それが**動くこと**は誰も確かめていない

つまり「書いてあるか」の検査しかしていなかった。これは静的解析で機械的に検出できる型である。
"""
import ast
import os
import sys

BRIDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bridge.py')
pass_n = fail_n = 0


def check(name, cond, detail=''):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print('  ✅ ' + name)
    else:
        fail_n += 1
        print('  ❌ ' + name + ('  → ' + str(detail) if detail else ''))


def module_level_names(tree):
    """モジュール直下で代入されている名前（関数から参照されうるもの）。"""
    names = set()
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            if isinstance(node.target, ast.Name):
                names.add(node.target.id)
    return names


def function_scopes(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node


def collisions(tree):
    """モジュール変数と同名の代入を関数内で行い、かつ同じ関数内で参照している箇所。

    `global` 宣言があれば意図的な共有なので除外する。
    """
    mod = module_level_names(tree)
    found = []
    for fn in function_scopes(tree):
        assigned, used, declared = set(), set(), set()
        for n in ast.walk(fn):
            if isinstance(n, ast.Name):
                (assigned if isinstance(n.ctx, ast.Store) else used).add(n.id)
            elif isinstance(n, ast.Global):
                declared.update(n.names)
        for name in sorted((mod & assigned & used) - declared):
            found.append((fn.name, name))
    return found


def main():
    src = open(BRIDGE, encoding='utf-8').read()
    tree = ast.parse(src)

    print('\n══ モジュール変数名を関数内で再代入していないか（UnboundLocalError の型） ══')
    found = collisions(tree)
    check('スコープ衝突が無い', not found, found)

    print('\n══ 回帰：9/2 に落ちた `_gate_state` が poll_iracing 内で代入されていない ══')
    fn = next(f for f in function_scopes(tree) if f.name == 'poll_iracing')
    assigned = {n.id for n in ast.walk(fn)
                if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    check("poll_iracing が `_gate_state` へ代入していない",
          '_gate_state' not in assigned)
    check("`_gate_state` はモジュール変数として存在する",
          '_gate_state' in module_level_names(tree))
    check('RACE SUMMARY GATE の計装は専用名を使っている',
          '_rs_gate_state' in assigned and 'RACE SUMMARY GATE:' in src)

    print('\n══ 参考：poll_iracing が参照するモジュール変数（代入していないもの＝正常） ══')
    used = {n.id for n in ast.walk(fn)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    shared = sorted((module_level_names(tree) & used) - assigned)
    print('  ' + str(len(shared)) + ' 件（これらは代入した瞬間に同じ事故が起きる）')
    print('  例: ' + ', '.join(shared[:12]))

    print('\n[scope collisions] 合格 %d / 不合格 %d' % (pass_n, fail_n))
    return 1 if fail_n else 0


if __name__ == '__main__':
    sys.exit(main())
