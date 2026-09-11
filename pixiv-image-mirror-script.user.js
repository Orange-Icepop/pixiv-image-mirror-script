// ==UserScript==
// @name         Pixiv Image Domain Replacement
// @name:zh      Pixiv图片域名替换
// @namespace    https://github.com/Orange-Icepop/pixiv-image-mirror-script
// @version      1.4
// @description  将页面上所有 i.pximg.net 的图片链接域名替换为镜像/反代站
// @author       Orange-Icepop Deepseek
// @match        *://*.pixiv.net/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';
    const proxy = "i.pixiv.re";
    
    // 替换单个 img 元素（如果包含 i.pximg.net 且未被替换过）
    function replaceImg(img) {
        // 避免重复处理
        if (img.dataset.pxReplaced === 'true') return;

        const src = img.src;
        if (src.includes('i.pximg.net')) {
            // 将 i.pximg.net 替换为代理，保持路径不变
            img.src = src.replace('i.pximg.net', proxy);
            img.dataset.pxReplaced = 'true';
        }
    }

    // 递归处理元素及其后代中的所有 img
    function processElement(element) {
        if (!element || !element.querySelectorAll) return;

        // 如果元素本身是 img，先处理它
        if (element.tagName === 'IMG') {
            replaceImg(element);
        }

        // 处理所有后代 img
        const imgs = element.querySelectorAll('img');
        imgs.forEach(img => replaceImg(img));
    }

    // 初始化：扫描页面上已有的所有 img
    processElement(document);

    // 创建 MutationObserver 监测动态添加的节点和 src 属性变化
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            // 处理新增的节点
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach((node) => {
                    // 只处理元素节点
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        processElement(node);
                    }
                });
            }

            // 处理 src 属性变化（仅当目标是 img 元素时）
            if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
                const target = mutation.target;
                if (target.tagName === 'IMG') {
                    replaceImg(target);
                }
            }
        });
    });

    // 开始观察整个文档的子孙节点添加、属性变化
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'] // 只监听 src 属性，减少不必要的回调
    });
})();
