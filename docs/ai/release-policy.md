# Release Policy

## バージョンポリシー

- 要件変更あり: マイナーアップ。
- コード修正のみ: パッチアップ。
- 要件を変えたら `docs/requirements-usdm.md` と `package.json` の `version` を揃える。

## publisher の責務

`publisher` は build / commit / push までを担当する。Marketplace 公開は `main` push 後に GitHub Actions が自動で行う。

標準フロー:

1. `git status -sb`
2. `npm run build`
3. `git diff --stat`
4. 必要な変更だけ stage
5. commit
6. push

`publisher` は機能コードの編集、不要なレビュー、リポジトリ全体の再調査、docs 全体の読み直し、`npm test` の実行をしない。
