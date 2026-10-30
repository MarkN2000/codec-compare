# 一時使用する音声コア

- ビルド日：2026-10-30
- ビルド元：[GitHub Actions実行 #41055682271](https://github.com/MarkN2000/kikikurabe/actions/runs/41055682271)
- サイトのビルド設定コミット：`7f9128b`
- ffmpeg.wasm上流コミット：`f876f907c7e9b9bf51d4ed0b913a855a63ae63fc`
- FFmpeg：5.1.4、Emscripten：3.1.40、シングルスレッド、スタック5 MiB
- 音声の変換・復号に必要な機能を有効にした構成。Opusは圧縮・復号ともlibopusを使用。詳細は `scripts/core.Dockerfile` を参照。
- `esm/ffmpeg-core.wasm` のSHA-256：`bc91fad67778f9f31004d1d213113565fcdf8701e03329cf421f587b77891a77`

7形式の変換、複数位置の区間復号、24 bit量子化と可逆形式の一致、設定変更、多チャンネル入力のステレオ化の検証を通過しています。6～24 kbpsのOpusと、SILK音声の先頭・末尾および区間位置も検証済みです。

修正を含む公式配布版がリリースされたら同じ検証を行い、公式版へ置き換えます。再ビルド時にはこの記録とハッシュも更新してください。ライセンス文書は `licenses/` に同梱しています。
