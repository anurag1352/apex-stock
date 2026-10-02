CREATE DATABASE IF NOT EXISTS apex_auth CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS apex_user CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS apex_stock CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS apex_market CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS apex_portfolio CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS apex_order CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS apex_watchlist CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS apex_notification CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS apex_analytics CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'apex_auth'@'%' IDENTIFIED BY 'apex-service-dev-password';
CREATE USER IF NOT EXISTS 'apex_user'@'%' IDENTIFIED BY 'apex-service-dev-password';
CREATE USER IF NOT EXISTS 'apex_stock'@'%' IDENTIFIED BY 'apex-service-dev-password';
CREATE USER IF NOT EXISTS 'apex_market'@'%' IDENTIFIED BY 'apex-service-dev-password';
CREATE USER IF NOT EXISTS 'apex_portfolio'@'%' IDENTIFIED BY 'apex-service-dev-password';
CREATE USER IF NOT EXISTS 'apex_order'@'%' IDENTIFIED BY 'apex-service-dev-password';
CREATE USER IF NOT EXISTS 'apex_watchlist'@'%' IDENTIFIED BY 'apex-service-dev-password';
CREATE USER IF NOT EXISTS 'apex_notification'@'%' IDENTIFIED BY 'apex-service-dev-password';
CREATE USER IF NOT EXISTS 'apex_analytics'@'%' IDENTIFIED BY 'apex-service-dev-password';

ALTER USER 'apex_auth'@'%' IDENTIFIED BY 'apex-service-dev-password';
ALTER USER 'apex_user'@'%' IDENTIFIED BY 'apex-service-dev-password';
ALTER USER 'apex_stock'@'%' IDENTIFIED BY 'apex-service-dev-password';
ALTER USER 'apex_market'@'%' IDENTIFIED BY 'apex-service-dev-password';
ALTER USER 'apex_portfolio'@'%' IDENTIFIED BY 'apex-service-dev-password';
ALTER USER 'apex_order'@'%' IDENTIFIED BY 'apex-service-dev-password';
ALTER USER 'apex_watchlist'@'%' IDENTIFIED BY 'apex-service-dev-password';
ALTER USER 'apex_notification'@'%' IDENTIFIED BY 'apex-service-dev-password';
ALTER USER 'apex_analytics'@'%' IDENTIFIED BY 'apex-service-dev-password';

GRANT ALL PRIVILEGES ON apex_auth.* TO 'apex_auth'@'%';
GRANT ALL PRIVILEGES ON apex_user.* TO 'apex_user'@'%';
GRANT ALL PRIVILEGES ON apex_stock.* TO 'apex_stock'@'%';
GRANT ALL PRIVILEGES ON apex_market.* TO 'apex_market'@'%';
GRANT ALL PRIVILEGES ON apex_portfolio.* TO 'apex_portfolio'@'%';
GRANT ALL PRIVILEGES ON apex_order.* TO 'apex_order'@'%';
GRANT ALL PRIVILEGES ON apex_watchlist.* TO 'apex_watchlist'@'%';
GRANT ALL PRIVILEGES ON apex_notification.* TO 'apex_notification'@'%';
GRANT ALL PRIVILEGES ON apex_analytics.* TO 'apex_analytics'@'%';

FLUSH PRIVILEGES;