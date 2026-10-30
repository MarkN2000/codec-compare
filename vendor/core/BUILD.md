# 一時使用する音声コア

- ビルド日：2026-10-31（日本時間）
- ビルド元：[GitHub Actions実行 #41120844506](https://github.com/MarkN2000/kikikurabe/actions/runs/41120844506)
- サイトのビルド設定コミット：`46a53822e817c86bc4c4fa3a62e7605e51489614`（ビルド専用ブランチ）
- ffmpeg.wasm上流コミット：`f876f907c7e9b9bf51d4ed0b913a855a63ae63fc`
- FFmpeg：5.1.4、Emscripten：3.1.40、シングルスレッド、スタック5 MiB
- 音声の変換・復号に必要な機能を有効にした構成。Opusは圧縮・復号ともlibopusを使用。SBC、G.722、G.711 μ-law／A-lawと末尾補完用apadを追加。詳細は `scripts/core.Dockerfile` を参照。
- LC3はGoogle liblc3のコミット`f9c127fd35975a0494b9e187589501ee984dc4b6`を使用。FFmpeg公式コミット`a3c5339578cb1d54322e06b6bd1c8852fc6abc29`のLC3接続コードを5.1.4向けに適合。移植内容は `scripts/lc3/README.md`、ライセンスは `licenses/lc3.txt` に記録。
- `esm/ffmpeg-core.wasm` のSHA-256：`7c950ea9478ffb8169d072f5b8d23f47737fce9e0895bb28f9f807887ac63059`

12形式の変換、複数位置の区間復号、24 bit量子化と可逆形式の一致、設定変更、多チャンネル入力のステレオ化の検証を通過しています。LC3・SBCは選択可能な全設定候補で末尾と途中位置を照合し、追加5形式はPCM対照との位置合わせも検証済みです。6～24 kbpsのOpusと、SILK音声の先頭・末尾および区間位置も検証済みです。mSBC・aptX系はサイトの比較形式に含めません。

修正を含む公式配布版がリリースされたら同じ検証を行い、公式版へ置き換えます。再ビルド時にはこの記録とハッシュも更新してください。ライセンス文書は `licenses/` に同梱しています。
