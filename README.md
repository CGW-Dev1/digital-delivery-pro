# Digital Delivery Pro

面向虚拟商品、卡密和资料链接的自动发货商城。项目使用 React + Express，支持库存预占、MockPay 支付确认、自动发货、订单查询和后台运营。

## 功能

- 前台分类货架、商品搜索、库存展示、限购和优惠码下单
- 支付方式配置，内置 MockPay 演示支付
- 下单时预占库存，订单超时自动释放库存
- 支付确认后自动发货，并在订单中展示卡密或资料链接
- 用户可通过订单号、联系方式或账号查看订单
- 后台支持分类、商品、库存、订单、支付方式、优惠券、公告和店铺设置
- 本地默认使用 SQLite，生产部署可切换到 MySQL

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

本地默认 SQLite：

```text
PORT=8787
DATABASE_CLIENT=sqlite
DATABASE_PATH=/opt/digital-delivery-pro/data/store.sqlite
JWT_SECRET=change-me
DELIVERY_SECRET_KEY=replace-with-32-byte-random-base64-or-64-hex
ADMIN_USER=admin
ADMIN_PASSWORD=ChangeMe123!
RESERVATION_MINUTES=15
```

虚拟机生产 MySQL：

```text
PORT=8787
DATABASE_CLIENT=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=digital_delivery
MYSQL_PASSWORD=change-this-password
MYSQL_DATABASE=digital_delivery_pro
MYSQL_CONNECTION_LIMIT=10
JWT_SECRET=replace-with-a-long-random-secret
DELIVERY_SECRET_KEY=replace-with-32-byte-random-base64-or-64-hex
CORS_ORIGINS=https://your-domain.example
ENABLE_MOCK_PAYMENT=false
ADMIN_USER=admin
ADMIN_PASSWORD=replace-admin-password
RESERVATION_MINUTES=15
```

也可以使用连接串：

```text
DATABASE_CLIENT=mysql
MYSQL_URL=mysql://digital_delivery:change-this-password@127.0.0.1:3306/digital_delivery_pro
```

## MySQL 初始化

先在虚拟机 MySQL 中创建数据库和账号：

```sql
CREATE DATABASE digital_delivery_pro
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'digital_delivery'@'%' IDENTIFIED BY 'change-this-password';
GRANT ALL PRIVILEGES ON digital_delivery_pro.* TO 'digital_delivery'@'%';
FLUSH PRIVILEGES;
```

应用启动时会自动创建表和初始化演示数据。所有商品、分类、库存、订单、用户、支付方式、优惠券、公告、店铺设置和审计日志都会写入数据库。

## 生产部署建议

```bash
npm ci
npm run build
DATABASE_CLIENT=mysql npm start
```

建议在虚拟机上用 systemd 或 PM2 托管 `npm start`，并用 Nginx 反向代理前端静态文件和后端 API。

## 接入真实支付

当前 `POST /api/payments/mock/:orderNo/confirm` 是本地演示支付。生产环境默认禁用 MockPay；如果只是演示站，才显式设置 `ENABLE_MOCK_PAYMENT=true`。接入真实支付时建议新增支付单表和签名校验，并在支付平台回调中复用同一套发货事务。

- `DELIVERY_SECRET_KEY` 用于 AES-GCM 加密库存卡密，生产环境必须配置并妥善备份；丢失后无法解密已加密卡密
- 回调必须幂等，同一订单重复回调只返回已发货订单
- 发货必须在数据库事务内完成
- 只发放该订单预占的库存
- 支付金额、订单号、签名和支付状态必须全部校验

## 项目结构

```text
src/client/       React 前台和后台界面
src/server/       Express API、数据库 schema、业务服务
src/shared/       前后端共享类型
data/             SQLite 本地模式生成的数据库目录
```
