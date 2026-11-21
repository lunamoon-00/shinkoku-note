-- 0009: お給料（給与所得）のルール（国税庁 No.1410 給与所得控除）
-- flat_upto 以下は「収入 − flat」（0円未満は0円）。special は令和8年分の注2の表（[上限, 給与所得の金額]）。
-- それより上〜6,599,999円は、所得税法別表第五の作り方（4,000円未満を切り捨てた額に式をあてる）。
-- 660万円以上は式どおり。源泉徴収票に「給与所得控除後の金額」があれば、そちらを優先して使う。
insert into tax_rules (year, key, value, source_url) values
(2025, 'salary', '{"flat":650000,"flat_upto":1900000,"special":[]}',
 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1410.htm'),
(2026, 'salary', '{"flat":740000,"flat_upto":2190999,"special":[[2192999,1451000],[2195999,1453000],[2199999,1456000]]}',
 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1410.htm');
