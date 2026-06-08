# Digital Delivery Pro

一个面向虚拟商品/卡密/资料链接的自动发货网站。项目参考了 `assimon/dujiaoka` 的核心业务方向，但使用现代 React + Express + SQLite 重新实现，内置库存预占、MockPay 支付确认、自动发货、订单查询和后台运营能力。

## 功能

- 前台分类货架、商品搜索、详情面板、库存展示、限购和优惠码下单
- 收银台支付方式选择，支持后台维护支付通道
- 下单时预占库存，订单超时自动释放库存
- MockPay 支付确认后自动发货并展示卡密
- 用户可通过订单号和联系方式查询已发货内容
- 后台登录、经营概览、分类管理、商品管理、库存导入、订单管理
- 优惠券、公告、店铺基础信息维护
- 商品分类和商品库存联动展示，订单和商品/库存/支付方式关联展示
- SQLite 本地持久化，首次启动自动创建表和演示数据
- API 测试覆盖下单发货和后台鉴权闭环

## 快速启动

```bash
npm install
npm run dev
```

前台地址：

```text
http://127.0.0.1:5173/
```

后台地址：

```text
http://127.0.0.1:5173/#admin
```

默认后台账号：

```text
账号：admin
密码：ChangeMe123!
```

## 常用命令

```bash
npm test
npm run build
npm start
```

## 环境变量

```text
PORT=8787
DATABASE_PATH=F:\MyProject\digital-delivery-pro\data\store.sqlite
JWT_SECRET=change-me
ADMIN_USER=admin
ADMIN_PASSWORD=ChangeMe123!
RESERVATION_MINUTES=15
```

## 接入真实支付

当前 `POST /api/payments/mock/:orderNo/confirm` 是本地演示支付。接入真实支付时建议新增支付单表和签名校验，在支付平台回调中调用同一套发货事务，保留以下原则：

- 回调必须幂等，同一订单重复回调只返回已发货订单
- 发货必须在数据库事务内完成
- 只发放该订单预占的库存
- 支付金额、订单号、签名和支付状态必须全部校验

## 项目结构

```text
src/client/       React 前台和后台界面
src/server/       Express API、SQLite schema、业务服务
src/shared/       前后端共享类型
data/             运行后生成的 SQLite 数据库
```
