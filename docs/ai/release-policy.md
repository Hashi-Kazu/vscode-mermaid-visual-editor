# Release Policy

## バージョンポリシー

- 要件変更あり: マイナーアップ。
- コード修正のみ: パッチアップ。
- 要件を変えたら `docs/requirements-usdm.md` と `package.json` の `version` を揃える。

## publish 手順（main が直接実行）

main は build / commit / push までを直接実行する。Marketplace 公開は `main` push 後に GitHub Actions が自動で行う。

標準フロー:

1. `git status -sb`
2. `npm run build`
3. `git diff --stat`
4. 必要な変更だけ stage
5. commit
6. push

機能コードの編集、不要なレビュー、リポジトリ全体の再調査、docs 全体の読み直し、`npm test` の実行はしない。
