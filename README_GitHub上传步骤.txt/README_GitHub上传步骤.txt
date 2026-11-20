更新现有 GitHub 源仓库（不需要运行 CMD / PowerShell）

1. 先下载并解压这个更新包。
2. 打开解压后的 FF14_Srank_Desktop_v4.0.0_GitHub源仓库 文件夹。
3. 打开你的 GitHub 仓库网页，回到仓库 Code 首页。
4. 点击 Add file -> Upload files。
5. 把这个文件夹里面的全部内容拖进 GitHub 上传区域（注意：是文件夹里面的内容，不是 ZIP 文件）。
   必须包含：main.js、package.json、preload.js、app 文件夹、bridge 文件夹、tests 文件夹、.github 文件夹等。
6. 在 Commit changes 里填写：Upgrade to FF14 Srank Desktop v4.0.0，然后提交。
7. 上传提交后，打开 Actions，检查 Build FF14 Srank Desktop for Windows 是否自动运行。
8. 测试通过后，在该次运行页面下方 Artifacts 下载新版 EXE。

关于原来根目录的 index.html：
- 暂时不要急着删除，它可以作为旧版备份。
- 新版构建读取根目录 package.json / main.js，以及 app/index.html。
- 旧的根目录 index.html 不参与新版桌面 EXE 构建。
- 等确认新版 EXE 构建成功、运行正常，再考虑把旧 index.html 删除或移到 legacy 文件夹。

安全：绝对不要上传 config.json、.env、cookies.json、APIToken、密码或个人 data 目录。
